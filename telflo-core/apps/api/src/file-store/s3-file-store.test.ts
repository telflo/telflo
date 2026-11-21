import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { describeFileStoreContract } from "../testing/file-store-contract.js";
import { createFileStore } from "./create-file-store.js";
import { fileKeyName } from "./file-key.js";
import {
  FileStoreError,
  type FileKey,
  type FileStoreSettings,
  type IFileStore,
  type S3FileStoreSettings,
} from "./file-store.js";
import { createS3FileStore, MAX_BUFFERED_BYTES, READ_IDLE_TIMEOUT_MS } from "./s3-file-store.js";

// S3FileStore against the S3 test server, the pinned SeaweedFS, and against
// loopback stubs for what SeaweedFS can't answer (a 403 for a missing key, a
// 500, a 503, a reset, a listener that never answers).
//
// Secrets in this file's output, as a class: the test server's keys come from the environment and are never
// printed; anything that could hold a key or a secret (an error, its
// message, a request) is only ever looked at through booleans, never
// toEqual, toContain or a message comparison that would print it.

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// --- The test server ---------------------------------------------------

function testServer(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  const endpoint = process.env.TELFLO_TEST_S3_ENDPOINT ?? "";
  const accessKeyId = process.env.TELFLO_TEST_S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.TELFLO_TEST_S3_SECRET_ACCESS_KEY ?? "";
  // Loudly, never a silent skip. Names only.
  if (endpoint === "" || accessKeyId === "" || secretAccessKey === "") {
    throw new Error(
      "The S3 tests need TELFLO_TEST_S3_ENDPOINT, TELFLO_TEST_S3_ACCESS_KEY_ID and TELFLO_TEST_S3_SECRET_ACCESS_KEY " +
        "(the S3 test server's: npm run dev:services, and telflo-core/.env.example's values).",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("TELFLO_TEST_S3_ENDPOINT must be a URL.");
  }
  // A test never reaches a real cloud.
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("TELFLO_TEST_S3_ENDPOINT must be a loopback http URL (127.0.0.1, [::1] or localhost).");
  }
  return { endpoint, accessKeyId, secretAccessKey };
}

const TEST_SERVER = testServer();
const TEST_BUCKET = "telflo-test";
const REGION = "us-east-1";

/**
 * Puts the test server's keys where the SDK's default chain reads them, the
 * production path (vitest.setup.ts left them ""), before a store's first
 * request: the SDK caches a client's credentials.
 */
function useTestKeys(): void {
  vi.stubEnv("AWS_ACCESS_KEY_ID", TEST_SERVER.accessKeyId);
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", TEST_SERVER.secretAccessKey);
}

function settingsFor(overrides: Partial<S3FileStoreSettings> = {}): S3FileStoreSettings {
  return {
    kind: "s3",
    bucket: TEST_BUCKET,
    prefix: `contract-${randomUUID()}/`,
    region: REGION,
    endpoint: TEST_SERVER.endpoint,
    forcePathStyle: true,
    ...overrides,
  };
}

/** A token-shaped code of a test's own S3 call's error, so no SDK error reaches the test's output. */
function codeOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(name) ? name : "unknown";
}

/** The test's own client, for setting up and checking, never a store's. Keys from the environment too. */
async function withTestClient<Result>(work: (client: S3Client) => Promise<Result>): Promise<Result> {
  useTestKeys();
  const client = new S3Client({
    region: REGION,
    endpoint: TEST_SERVER.endpoint,
    forcePathStyle: true,
  });
  try {
    return await work(client);
  } catch (error) {
    throw new Error(`The test's own S3 call failed (${codeOf(error)}).`);
  } finally {
    client.destroy();
  }
}

/** Every object name under `prefix`. */
async function objectsUnder(prefix: string): Promise<string[]> {
  return withTestClient(async (client) => {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: TEST_BUCKET, Prefix: prefix }));
    return (listed.Contents ?? []).map((object) => object.Key ?? "").sort();
  });
}

/** Removes every object under `prefix`, then shows none is left. */
async function removeObjectsUnder(prefix: string): Promise<void> {
  const names = await objectsUnder(prefix);
  await withTestClient(async (client) => {
    for (const name of names) await client.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: name }));
  });
  expect((await objectsUnder(prefix)).length).toBe(0);
}

beforeAll(async () => {
  // The bucket the setup creates if missing.
  await withTestClient(async (client) => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
    } catch (error) {
      if (codeOf(error) !== "BucketAlreadyOwnedByYou") throw error;
    }
  });
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Counts the S3 requests of every client but the test's own; restored and its clients closed by `stop`. */
function spyOnRequests(): {
  send: MockInstance<S3Client["send"]>;
  count: () => number;
  commands: () => unknown[];
  stop: () => void;
} {
  const send = vi.spyOn(S3Client.prototype, "send");
  return {
    send,
    count: () => send.mock.calls.length,
    commands: () => send.mock.calls.map((call) => call[0]),
    stop: () => {
      const clients = new Set(send.mock.contexts as S3Client[]);
      send.mockRestore();
      for (const client of clients) client.destroy();
    },
  };
}

// --- The contract --------------------------------------------------------

describeFileStoreContract("S3FileStore", async () => {
  useTestKeys();
  const settings = settingsFor();
  const requests = spyOnRequests();
  const store = await createS3FileStore(settings);
  return {
    store,
    cleanUp: async () => {
      requests.stop();
      await removeObjectsUnder(settings.prefix);
      vi.unstubAllEnvs();
    },
    countBackendCalls: requests.count,
  };
});

// --- Keys and canaries ---------------------------------------------------

const ORGANIZATION = "0190f5c2-7d1a-7c4e-8a3b-1f2e3d4c5b6a";
const USER = "0190f5c2-7d1a-7c4e-8a3b-2f2e3d4c5b6a";
const FILE = "0190f5c2-7d1a-7c4e-8a3b-3f2e3d4c5b6a";
const KEY: FileKey = {
  kind: "test-input",
  organizationId: ORGANIZATION,
  userId: USER,
  fileId: FILE,
};
const MAX = 10 * 1024 * 1024 + 1;

async function* chunks(...parts: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}

async function readText(store: IFileStore, key: FileKey): Promise<string | undefined> {
  const result = await store.read(key);
  return result.found ? (await buffer(result.stream)).toString("utf8") : undefined;
}

function sha256(content: string | Uint8Array): Buffer {
  return createHash("sha256").update(content).digest();
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * Whether any of `canaries` appears anywhere in the error: its message, its
 * stack, every own property (hidden ones too), and the properties S3's and
 * Node's errors carry (`body`, `Resource`, `Key`, `BucketName`, `$response`,
 * `$metadata`, `cause`, `address`, `port`). A boolean: the error is never
 * printed.
 */
function holdsAny(error: unknown, canaries: string[]): boolean {
  const options = {
    depth: 12,
    showHidden: true,
    maxStringLength: Infinity,
    maxArrayLength: Infinity,
  } as const;
  const texts = [String(error), inspect(error, options)];
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const names = new Set([
      ...Object.getOwnPropertyNames(error),
      "message",
      "stack",
      "body",
      "Resource",
      "Key",
      "BucketName",
      "$response",
      "$metadata",
      "cause",
      "address",
      "port",
    ]);
    for (const name of names) {
      const value = record[name];
      texts.push(typeof value === "string" ? value : inspect(value, options));
    }
  }
  return texts.some((text) => canaries.some((canary) => canary !== "" && text.includes(canary)));
}

/** What no error may hold: the test server's keys, a signature's parts, the key's ids. */
function secretsAndIds(): string[] {
  return [
    TEST_SERVER.accessKeyId,
    TEST_SERVER.secretAccessKey,
    "AWS4-HMAC-SHA256",
    "Signature=",
    "Credential=",
    ORGANIZATION,
    USER,
    FILE,
  ];
}

/**
 * The error is the store's own FileStoreError, holding the code and the
 * operation only. Booleans: the error is never printed.
 */
function expectStoreError(error: unknown, code: string | undefined, operation: string): void {
  expect(error instanceof FileStoreError, "a FileStoreError").toBe(true);
  const storeError = error as FileStoreError;
  expect(storeError.code === code, `its code is ${code ?? "undefined"}`).toBe(true);
  expect(storeError.syscall === operation, `its operation is ${operation}`).toBe(true);
  expect(
    storeError.message === `A file store operation failed (${operation}: ${code ?? "unknown error"}).`,
    "its message is the fixed one",
  ).toBe(true);
  // Property names only: nothing else of the SDK's error is kept.
  expect(Object.getOwnPropertyNames(storeError).sort()).toEqual(["code", "message", "name", "stack", "syscall"]);
  expect("cause" in storeError, "no cause").toBe(false);
}

// --- Loopback stubs ------------------------------------------------------

/** Text only a stub's replies hold. */
const SERVER_TEXT = `stub-server-text-${randomUUID()}`;

function s3ErrorXml(code: string, bucket: string, key: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
    `<Message>${SERVER_TEXT} for ${bucket}/${key}</Message><Resource>/${bucket}/${key}</Resource>` +
    `<Key>${key}</Key><BucketName>${bucket}</BucketName><RequestId>stub-request</RequestId></Error>`
  );
}

interface StubRequest {
  method: string;
  bucket: string;
  key: string;
}

interface Stub {
  endpoint: string;
  /** host:port, which no error may hold. */
  address: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

/**
 * An S3 stand-in on 127.0.0.1:0, path style, its behavior chosen by the
 * bucket. The startup check's probes are answered as S3 answers them (PUT
 * 200, a missing name 404 NoSuchKey, DELETE 204) unless the bucket says
 * otherwise; every other request gets the bucket's failure.
 */
async function startStub(): Promise<Stub> {
  const requests: StubRequest[] = [];
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const [, bucket = "", ...rest] = (request.url ?? "").split("?")[0]!.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const method = request.method ?? "";
    requests.push({ method, bucket, key });
    const name = key.split("/").at(-1) ?? "";
    const isWriteProbe = name.startsWith(".write-probe-");
    const isMissingProbe = name.startsWith(".missing-probe-");
    const send = (status: number, body: string | Buffer = "", headers: Record<string, string> = {}): void => {
      response.writeHead(status, {
        "content-type": "application/xml",
        ...headers,
      });
      response.end(body);
    };
    request.resume();
    request.on("end", () => {
      if (isMissingProbe) {
        if (bucket === "stub-403-missing") return send(403, s3ErrorXml("AccessDenied", bucket, key));
        if (bucket === "stub-found")
          return send(200, "x", {
            "content-type": "application/octet-stream",
          });
        return send(404, s3ErrorXml("NoSuchKey", bucket, key));
      }
      if (isWriteProbe && method === "PUT") return send(200, "", { etag: '"stub"' });
      if (isWriteProbe && method === "DELETE") {
        if (bucket === "stub-no-delete") return send(403, s3ErrorXml("AccessDenied", bucket, key));
        return send(204);
      }
      switch (bucket) {
        case "stub-500":
          return send(500, s3ErrorXml("InternalError", bucket, key));
        case "stub-503":
          return send(503, s3ErrorXml("SlowDown", bucket, key));
        case "stub-502-html":
          return send(502, `<html><body>${SERVER_TEXT}: bad gateway for /${bucket}/${key}</body></html>`, {
            "content-type": "text/html",
          });
        case "stub-reset":
          if (method !== "GET") return send(200, "", { etag: '"stub"' });
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": "1000",
          });
          response.write(Buffer.alloc(100, 1));
          setTimeout(() => request.socket.destroy(), 50);
          return;
        case "stub-bad-checksum": {
          const bytes = Buffer.from("these are the bytes");
          return send(200, bytes, {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
            "x-amz-checksum-sha256": sha256(`other bytes ${SERVER_TEXT}`).toString("base64"),
          });
        }
        case "stub-stall":
          // Headers and ten bytes, then nothing, ever.
          if (method !== "GET") return send(200, "", { etag: '"stub"' });
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
          response.write(Buffer.alloc(10, 1));
          return;
        case "stub-late-end":
          // Five of ten bytes, then the last five and the end a second later.
          if (method !== "GET") return send(200, "", { etag: '"stub"' });
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "10" });
          response.write(Buffer.from("01234"));
          setTimeout(() => response.end(Buffer.from("56789")), 1_000);
          return;
        case "stub-chunked":
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "transfer-encoding": "chunked",
          });
          return response.end("chunked body");
        default:
          return send(404, s3ErrorXml("NoSuchBucket", bucket, key));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    address: `127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A node:net listener that accepts and never answers a store's request. It
 * answers only the startup check's three probes (raw HTTP), so a store can be
 * built on it; every other request is counted and left waiting forever.
 */
async function startQuietListener(): Promise<{
  endpoint: string;
  unanswered: () => number;
  close: () => Promise<void>;
}> {
  let unanswered = 0;
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    let isStalled = false;
    socket.on("data", (data: Buffer) => {
      if (isStalled) return;
      pending += data.toString("latin1");
      for (;;) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = pending.slice(0, end);
        pending = pending.slice(end + 4);
        const [method = "", target = ""] = head.split(" ");
        if (method === "PUT" && target.includes("/.write-probe-")) {
          socket.write('HTTP/1.1 200 OK\r\nETag: "quiet"\r\nContent-Length: 0\r\n\r\n');
        } else if (method === "DELETE" && target.includes("/.write-probe-")) {
          socket.write("HTTP/1.1 204 No Content\r\n\r\n");
        } else if (method === "GET" && target.includes("/.missing-probe-")) {
          const body =
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>none</Message></Error>';
          socket.write(
            `HTTP/1.1 404 Not Found\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        } else {
          isStalled = true;
          unanswered += 1;
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    unanswered: () => unanswered,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on: one taken, then let go. */
async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A store on a stub's bucket; the startup check passes on its probes. */
async function stubStore(stub: Stub, bucket: string): Promise<IFileStore> {
  useTestKeys();
  return createS3FileStore(settingsFor({ bucket, endpoint: stub.endpoint, prefix: "stub/" }));
}

function refusalText(problem: string, where: string, operation: string, code: string, advice = ""): string {
  return `The file store's bucket (TELFLO_FILE_STORE_BUCKET) ${problem}: ${where} (${operation}: ${code})${advice}`;
}

const LIST_ADVICE = ". A missing file must answer NoSuchKey: grant the API's role s3:ListBucket on the bucket.";

// --- S3's own cases ------------------------------------------------------

describe("S3FileStore, on the S3 test server", () => {
  let stub: Stub;
  beforeAll(async () => {
    stub = await startStub();
    return () => stub.close();
  });

  describe("the startup check", () => {
    it("passes: a probe written, a missing name answered NoSuchKey, the probe removed, all under the prefix", async () => {
      useTestKeys();
      const settings = settingsFor();
      const requests = spyOnRequests();
      try {
        await createS3FileStore(settings);
        const commands = requests.commands();
        expect(commands.map((command) => command?.constructor.name)).toEqual([
          "PutObjectCommand",
          "GetObjectCommand",
          "DeleteObjectCommand",
        ]);
        const [put, get, remove] = commands as [PutObjectCommand, GetObjectCommand, DeleteObjectCommand];
        expect(put.input.Key?.startsWith(`${settings.prefix}.write-probe-`)).toBe(true);
        expect(get.input.Key?.startsWith(`${settings.prefix}.missing-probe-`)).toBe(true);
        expect(remove.input.Key === put.input.Key).toBe(true);
        expect(await objectsUnder(settings.prefix)).toEqual([]);
      } finally {
        requests.stop();
      }
    });

    it("refuses a bucket that doesn't exist, naming the bucket, the prefix, the step and the code only", async () => {
      useTestKeys();
      const bucket = `telflo-missing-${randomUUID().slice(0, 8)}`;
      const settings = settingsFor({ bucket });
      const error = await rejectionOf(createS3FileStore(settings));
      const where = `${bucket} with prefix ${settings.prefix} (TELFLO_FILE_STORE_PREFIX)`;
      expect(error instanceof Error).toBe(true);
      expect((error as Error).message === refusalText("can't be written", where, "PutObject", "NoSuchBucket")).toBe(
        true,
      );
      expect(holdsAny(error, [...secretsAndIds(), TEST_SERVER.endpoint, "does not exist"])).toBe(false);
      expect("cause" in (error as Error)).toBe(false);
    });

    it("names no prefix when there is none", async () => {
      useTestKeys();
      const bucket = `telflo-missing-${randomUUID().slice(0, 8)}`;
      const error = await rejectionOf(createS3FileStore(settingsFor({ bucket, prefix: "" })));
      expect((error as Error).message === refusalText("can't be written", bucket, "PutObject", "NoSuchBucket")).toBe(
        true,
      );
    });

    it("refuses a wrong secret (SignatureDoesNotMatch), holding no key or secret", async () => {
      const wrongSecret = `wrong-secret-${randomUUID()}`;
      vi.stubEnv("AWS_ACCESS_KEY_ID", TEST_SERVER.accessKeyId);
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", wrongSecret);
      const settings = settingsFor();
      const error = await rejectionOf(createS3FileStore(settings));
      const where = `${TEST_BUCKET} with prefix ${settings.prefix} (TELFLO_FILE_STORE_PREFIX)`;
      expect(
        (error as Error).message === refusalText("can't be written", where, "PutObject", "SignatureDoesNotMatch"),
      ).toBe(true);
      expect(holdsAny(error, [...secretsAndIds(), wrongSecret, TEST_SERVER.endpoint])).toBe(false);
    });

    it("refuses an unknown access key (InvalidAccessKeyId), holding no key or secret", async () => {
      const unknownKey = `unknown-key-${randomUUID()}`;
      vi.stubEnv("AWS_ACCESS_KEY_ID", unknownKey);
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", TEST_SERVER.secretAccessKey);
      const settings = settingsFor();
      const error = await rejectionOf(createS3FileStore(settings));
      const where = `${TEST_BUCKET} with prefix ${settings.prefix} (TELFLO_FILE_STORE_PREFIX)`;
      expect(
        (error as Error).message === refusalText("can't be written", where, "PutObject", "InvalidAccessKeyId"),
      ).toBe(true);
      expect(holdsAny(error, [...secretsAndIds(), unknownKey, TEST_SERVER.endpoint])).toBe(false);
    });

    it("refuses a closed port (ECONNREFUSED), naming no endpoint", async () => {
      useTestKeys();
      const port = await closedPort();
      const endpoint = `http://127.0.0.1:${port}`;
      const error = await rejectionOf(createS3FileStore(settingsFor({ endpoint, prefix: "" })));
      expect(
        (error as Error).message === refusalText("can't be written", TEST_BUCKET, "PutObject", "ECONNREFUSED"),
      ).toBe(true);
      expect(holdsAny(error, [...secretsAndIds(), `127.0.0.1:${port}`, String(port)])).toBe(false);
    });

    describe("against a loopback stub", () => {
      it("refuses a missing key answered 403 AccessDenied (no s3:ListBucket), telling to grant it, and removes its probe", async () => {
        stub.requests.length = 0;
        useTestKeys();
        const error = await rejectionOf(
          createS3FileStore(
            settingsFor({
              bucket: "stub-403-missing",
              endpoint: stub.endpoint,
              prefix: "",
            }),
          ),
        );
        expect(
          (error as Error).message ===
            refusalText("can't tell a missing file", "stub-403-missing", "GetObject", "AccessDenied", LIST_ADVICE),
        ).toBe(true);
        expect(holdsAny(error, [...secretsAndIds(), SERVER_TEXT, stub.address, ".missing-probe-"])).toBe(false);
        expect(stub.requests.map(({ method }) => method)).toEqual(["PUT", "GET", "DELETE"]);
        expect(stub.requests[2]!.key === stub.requests[0]!.key).toBe(true);
      });

      it("refuses a server that answers a name never written as found", async () => {
        useTestKeys();
        const error = await rejectionOf(
          createS3FileStore(
            settingsFor({
              bucket: "stub-found",
              endpoint: stub.endpoint,
              prefix: "",
            }),
          ),
        );
        expect(
          (error as Error).message ===
            refusalText("can't tell a missing file", "stub-found", "GetObject", "answered found", LIST_ADVICE),
        ).toBe(true);
      });

      it("refuses a bucket whose probe can't be removed", async () => {
        useTestKeys();
        const error = await rejectionOf(
          createS3FileStore(
            settingsFor({
              bucket: "stub-no-delete",
              endpoint: stub.endpoint,
              prefix: "",
            }),
          ),
        );
        expect(
          (error as Error).message ===
            refusalText("can't have a file removed", "stub-no-delete", "DeleteObject", "AccessDenied"),
        ).toBe(true);
        expect(holdsAny(error, [...secretsAndIds(), SERVER_TEXT, stub.address])).toBe(false);
      });
    });
  });

  describe("the server's and the network's failures map to codes only (a loopback stub)", () => {
    {
      it.each([
        ["a 500", "stub-500", "InternalError"],
        ["a 503", "stub-503", "SlowDown"],
        ["a 502 that isn't XML", "stub-502-html", undefined],
      ])(
        "%s maps to its code only, by every method, holding no id, server text, secret or endpoint",
        async (_name, bucket, code) => {
          const store = await stubStore(stub, bucket);
          const canaries = [...secretsAndIds(), SERVER_TEXT, stub.address, stub.endpoint, bucket, "stub/"];
          const writeError = await rejectionOf(store.write(KEY, chunks("bytes"), { maxBytes: MAX }));
          expectStoreError(writeError, code, "PutObject");
          expect(holdsAny(writeError, canaries)).toBe(false);
          const readError = await rejectionOf(store.read(KEY));
          expectStoreError(readError, code, "GetObject");
          expect(holdsAny(readError, canaries)).toBe(false);
          const removeError = await rejectionOf(store.remove(KEY));
          expectStoreError(removeError, code, "DeleteObject");
          expect(holdsAny(removeError, canaries)).toBe(false);
          const copyError = await rejectionOf(store.copy(KEY, { ...KEY, fileId: USER }));
          expectStoreError(copyError, code, "GetObject");
          expect(holdsAny(copyError, canaries)).toBe(false);
        },
      );

      it("a body reset mid-read errors the store's stream with a code only", async () => {
        const store = await stubStore(stub, "stub-reset");
        const result = await store.read(KEY);
        expect(result.found).toBe(true);
        if (!result.found) return;
        expect(result.sizeBytes).toBe(1000);
        const error = await rejectionOf(buffer(result.stream));
        expectStoreError(error, "ECONNRESET", "GetObject");
        expect(holdsAny(error, [...secretsAndIds(), "aborted", stub.address])).toBe(false);
      });

      it("a body failing its checksum errors the store's stream without either digest", async () => {
        const store = await stubStore(stub, "stub-bad-checksum");
        const result = await store.read(KEY);
        expect(result.found).toBe(true);
        if (!result.found) return;
        const error = await rejectionOf(buffer(result.stream));
        expectStoreError(error, undefined, "GetObject");
        const digests = [
          sha256(`other bytes ${SERVER_TEXT}`).toString("base64"),
          sha256("these are the bytes").toString("base64"),
        ];
        expect(holdsAny(error, [...secretsAndIds(), ...digests, "Checksum mismatch"])).toBe(false);
      });

      it("a reply with no length is a FileStoreError, its body closed", async () => {
        const store = await stubStore(stub, "stub-chunked");
        expectStoreError(await rejectionOf(store.read(KEY)), "InvalidContentLength", "GetObject");
      });
    }
  });

  describe("writes", () => {
    let store: IFileStore;
    let settings: S3FileStoreSettings;
    let requests: ReturnType<typeof spyOnRequests>;

    async function useStore(): Promise<void> {
      useTestKeys();
      settings = settingsFor();
      requests = spyOnRequests();
      store = await createS3FileStore(settings);
    }

    afterEach(async () => {
      requests.stop();
      await removeObjectsUnder(settings.prefix);
    });

    it("is one PutObject carrying the bytes' length, SHA-256 (base64), type and no encryption header", async () => {
      await useStore();
      const before = requests.count();
      const controller = new AbortController();
      const written = await store.write(KEY, chunks("hello, ", "object store"), {
        maxBytes: MAX,
        signal: controller.signal,
      });
      expect(written).toEqual({
        sizeBytes: 19,
        sha256: sha256("hello, object store").toString("hex"),
      });
      expect(requests.count() - before).toBe(1);
      const [command, options] = requests.send.mock.calls.at(-1)!;
      expect(command instanceof PutObjectCommand).toBe(true);
      const input = (command as PutObjectCommand).input;
      // Names only: the command holds no secret, but its input is checked field by field.
      expect(Object.keys(input).sort()).toEqual([
        "Body",
        "Bucket",
        "ChecksumSHA256",
        "ContentLength",
        "ContentType",
        "Key",
      ]);
      expect(input.ChecksumSHA256 === sha256("hello, object store").toString("base64")).toBe(true);
      expect(input.ContentLength).toBe(19);
      expect(input.ContentType).toBe("application/octet-stream");
      expect(input.Bucket).toBe(TEST_BUCKET);
      expect(input.Key).toBe(`${settings.prefix}${fileKeyName(KEY)}`);
      expect(Buffer.from(input.Body as Uint8Array).toString("utf8")).toBe("hello, object store");
      expect((options as { abortSignal?: unknown } | undefined)?.abortSignal === controller.signal).toBe(true);
      expect(await objectsUnder(settings.prefix)).toEqual([`${settings.prefix}${fileKeyName(KEY)}`]);
    });

    it("a body that doesn't match its checksum is refused by the server (BadDigest), keeping the old object", async () => {
      await useStore();
      await store.write(KEY, chunks("kept"), { maxBytes: MAX });
      // The source changes a chunk after the store has hashed it: what is
      // sent no longer matches the SHA-256 the request names.
      const first = Buffer.from("replacement");
      async function* changing(): AsyncIterable<Uint8Array> {
        yield first;
        first.fill(0x78);
        yield Buffer.from(" end");
      }
      const error = await rejectionOf(store.write(KEY, changing(), { maxBytes: MAX }));
      expectStoreError(error, "BadDigest", "PutObject");
      expect(holdsAny(error, [...secretsAndIds(), settings.prefix, TEST_SERVER.endpoint])).toBe(false);
      expect(await readText(store, KEY)).toBe("kept");
    });

    it("an abort after the source's last chunk sends nothing, rejects with the signal's reason and keeps the old object", async () => {
      await useStore();
      await store.write(KEY, chunks("kept"), { maxBytes: MAX });
      const controller = new AbortController();
      async function* abortingAtTheEnd(): AsyncIterable<Uint8Array> {
        yield Buffer.from("the whole replacement");
        controller.abort();
      }
      const before = requests.count();
      const error = await rejectionOf(
        store.write(KEY, abortingAtTheEnd(), {
          maxBytes: MAX,
          signal: controller.signal,
        }),
      );
      expect(requests.count() - before).toBe(0);
      expect(controller.signal.aborted).toBe(true);
      expect(error).toBe(controller.signal.reason);
      expect(await readText(store, KEY)).toBe("kept");
    });

    it("refuses a maxBytes above MAX_BUFFERED_BYTES (64 MiB) with a RangeError, before reading or any request", async () => {
      await useStore();
      expect(MAX_BUFFERED_BYTES).toBe(64 * 1024 * 1024);
      const source = Readable.from([Buffer.from("x")]);
      const before = requests.count();
      const error = await rejectionOf(store.write(KEY, source, { maxBytes: MAX_BUFFERED_BYTES + 1 }));
      expect(error).toBeInstanceOf(RangeError);
      expect(requests.count() - before).toBe(0);
      expect(source.destroyed).toBe(true);
      await expect(store.write(KEY, chunks("x"), { maxBytes: MAX_BUFFERED_BYTES })).resolves.toMatchObject({
        sizeBytes: 1,
      });
    });
  });

  describe("reads", () => {
    let settings: S3FileStoreSettings;
    let requests: ReturnType<typeof spyOnRequests>;

    afterEach(async () => {
      requests.stop();
      await removeObjectsUnder(settings.prefix);
    });

    it("the stream is the store's own; destroying it destroys the SDK's body, so many unread reads never run out of sockets", async () => {
      useTestKeys();
      settings = settingsFor();
      requests = spyOnRequests();
      const store = await createS3FileStore(settings);
      await store.write(KEY, chunks(Buffer.alloc(256 * 1024, 7)), {
        maxBytes: MAX,
      });
      for (let index = 0; index < 60; index += 1) {
        const result = await store.read(KEY);
        expect(result.found).toBe(true);
        if (!result.found) return;
        const output = (await requests.send.mock.results.at(-1)!.value) as {
          Body: Readable;
        };
        expect(result.stream === output.Body).toBe(false);
        result.stream.destroy();
        await new Promise((resolve) => setImmediate(resolve));
        expect(output.Body.destroyed).toBe(true);
      }
      expect((await readText(store, KEY))?.length).toBe(256 * 1024);
    });
  });

  describe("the prefix", () => {
    const prefixes: string[] = [];
    afterEach(async () => {
      for (const prefix of prefixes.splice(0)) await removeObjectsUnder(prefix);
    });

    it("keeps two stores in one bucket apart, each object named <prefix><key's name>", async () => {
      useTestKeys();
      const first = settingsFor();
      const second = settingsFor();
      prefixes.push(first.prefix, second.prefix);
      const one = await createS3FileStore(first);
      const two = await createS3FileStore(second);

      await one.write(KEY, chunks("the first install's"), { maxBytes: MAX });
      expect(await two.read(KEY)).toEqual({ found: false });
      await two.write(KEY, chunks("the second install's"), { maxBytes: MAX });
      expect(await readText(one, KEY)).toBe("the first install's");
      expect(await readText(two, KEY)).toBe("the second install's");
      expect(await objectsUnder(first.prefix)).toEqual([`${first.prefix}${fileKeyName(KEY)}`]);
      expect(await objectsUnder(second.prefix)).toEqual([`${second.prefix}${fileKeyName(KEY)}`]);

      await one.remove(KEY);
      expect(await one.read(KEY)).toEqual({ found: false });
      expect(await readText(two, KEY)).toBe("the second install's");
    });
  });

  describe("the timeouts", () => {
    it("two writes against a listener that never answers give up inside the dispatcher's 30-second reserve, three attempts each", async () => {
      const listener = await startQuietListener();
      try {
        useTestKeys();
        const store = await createS3FileStore(settingsFor({ endpoint: listener.endpoint, prefix: "" }));
        const started = performance.now();
        for (const name of ["output", "decoded-input"] as const) {
          const key: FileKey = {
            kind: "test-run",
            organizationId: ORGANIZATION,
            runId: FILE,
            name,
          };
          const error = await rejectionOf(store.write(key, chunks("an answer file"), { maxBytes: MAX }));
          expectStoreError(error, "TimeoutError", "PutObject");
          expect(holdsAny(error, [...secretsAndIds(), listener.endpoint])).toBe(false);
        }
        const elapsed = performance.now() - started;
        expect(listener.unanswered()).toBe(6);
        expect(elapsed).toBeLessThan(30_000);
      } finally {
        await listener.close();
      }
    }, 60_000);

    it("an abort while the PUT waits rejects with the signal's reason", async () => {
      const listener = await startQuietListener();
      try {
        useTestKeys();
        const store = await createS3FileStore(settingsFor({ endpoint: listener.endpoint, prefix: "" }));
        const controller = new AbortController();
        const write = store.write(KEY, chunks("bytes"), {
          maxBytes: MAX,
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(listener.unanswered()).toBe(1));
        controller.abort();
        expect(await rejectionOf(write)).toBe(controller.signal.reason);
      } finally {
        await listener.close();
      }
    });
  });

  describe("the endpoint is Telflo's setting alone", () => {
    /** A loopback server that records any request it gets, and answers none usefully. */
    async function startCanary(): Promise<{ endpoint: string; requests: () => number; close: () => Promise<void> }> {
      let requests = 0;
      const server = createHttpServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(500).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return {
        endpoint: `http://127.0.0.1:${port}`,
        requests: () => requests,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    it("AWS_ENDPOINT_URL and AWS_ENDPOINT_URL_S3 never take a store away from its endpoint", async () => {
      const canary = await startCanary();
      const settings = settingsFor();
      try {
        useTestKeys();
        vi.stubEnv("AWS_ENDPOINT_URL", canary.endpoint);
        vi.stubEnv("AWS_ENDPOINT_URL_S3", canary.endpoint);
        const store = await createS3FileStore(settings);
        await store.write(KEY, chunks("still on the test server"), { maxBytes: MAX });
        expect(await readText(store, KEY)).toBe("still on the test server");
        await store.remove(KEY);
        expect(canary.requests()).toBe(0);
      } finally {
        await canary.close();
        await removeObjectsUnder(settings.prefix);
      }
    });

    it("nor a store with no endpoint setting: its requests are built for AWS's own endpoint, never the variables' (stopped before any is sent)", async () => {
      const canary = await startCanary();
      // Every request is stopped once built (the build step: its host is
      // resolved, nothing is signed or sent), and its host recorded. Nothing
      // leaves the machine.
      const hosts: string[] = [];
      const instrumented = new WeakSet<S3Client>();
      const original = S3Client.prototype.send;
      const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(function (
        this: S3Client,
        ...args: Parameters<S3Client["send"]>
      ) {
        if (!instrumented.has(this)) {
          instrumented.add(this);
          this.middlewareStack.add(
            () => async (built) => {
              const request = built.request as { hostname?: unknown; port?: unknown };
              hosts.push(`${String(request.hostname)}:${String(request.port ?? "")}`);
              throw Object.assign(new Error("stopped before sending"), { name: "StoppedBeforeSending" });
            },
            { step: "build", name: "telfloTestStopBeforeSending", priority: "low" },
          );
        }
        return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      } as S3Client["send"]);
      try {
        useTestKeys();
        vi.stubEnv("AWS_ENDPOINT_URL", canary.endpoint);
        vi.stubEnv("AWS_ENDPOINT_URL_S3", canary.endpoint);
        const error = await rejectionOf(createS3FileStore(settingsFor({ endpoint: undefined, prefix: "" })));
        expect(
          (error as Error).message ===
            refusalText("can't be written", TEST_BUCKET, "PutObject", "StoppedBeforeSending"),
          "the probe was stopped before it was sent",
        ).toBe(true);
        expect(hosts.length).toBe(1);
        expect(
          hosts.every((host) => host.includes(".amazonaws.com:") && !host.includes("127.0.0.1")),
          "the request was built for AWS's own endpoint",
        ).toBe(true);
        expect(canary.requests()).toBe(0);
      } finally {
        const clients = new Set(send.mock.contexts as S3Client[]);
        send.mockRestore();
        for (const client of clients) client.destroy();
        await canary.close();
      }
    });
  });

  describe("missing credentials", () => {
    it("the startup check refuses with CredentialsProviderError, holding no cause and nothing else", async () => {
      // The chain finds nothing: the keys blank, the shared files missing,
      // no web identity, no container or instance role (vitest.setup.ts).
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      const settings = settingsFor();
      const error = await rejectionOf(createS3FileStore(settings));
      const where = `${TEST_BUCKET} with prefix ${settings.prefix} (TELFLO_FILE_STORE_PREFIX)`;
      expect(error instanceof Error).toBe(true);
      expect(
        (error as Error).message === refusalText("can't be written", where, "PutObject", "CredentialsProviderError"),
        "refused at PutObject with CredentialsProviderError",
      ).toBe(true);
      expect("cause" in (error as Error), "no cause").toBe(false);
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "stack"]);
      expect(holdsAny(error, [...secretsAndIds(), TEST_SERVER.endpoint, "Could not load credentials"])).toBe(false);
    });
  });

  describe("a read's backpressure and a copy's clean-up", () => {
    let settings: S3FileStoreSettings;
    let send: MockInstance<S3Client["send"]>;

    afterEach(async () => {
      const clients = new Set(send.mock.contexts as S3Client[]);
      send.mockRestore();
      for (const client of clients) client.destroy();
      await removeObjectsUnder(settings.prefix);
    });

    it("an unread stream of a large object stays bounded: the body is paused, the store's stream holds about its highWaterMark", async () => {
      useTestKeys();
      settings = settingsFor();
      send = vi.spyOn(S3Client.prototype, "send");
      const store = await createS3FileStore(settings);
      const size = 8 * 1024 * 1024;
      await store.write(KEY, chunks(Buffer.alloc(size, 9)), { maxBytes: MAX });

      const result = await store.read(KEY);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const output = (await send.mock.results.at(-1)!.value) as { Body: Readable };
      // Nobody reads: the body fills the store's stream to its mark, then waits.
      await vi.waitFor(() => expect(output.Body.isPaused()).toBe(true));
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      const mark = result.stream.readableHighWaterMark;
      expect(mark).toBeLessThan(size / 8);
      expect(result.stream.readableLength).toBeGreaterThan(0);
      expect(result.stream.readableLength).toBeLessThanOrEqual(2 * mark + 64 * 1024);
      expect(output.Body.isPaused()).toBe(true);
      // Reading resumes it, to the last byte.
      expect((await buffer(result.stream)).byteLength).toBe(size);
    });

    it("a copy whose write fails rejects with the store's own error and destroys the source's body", async () => {
      useTestKeys();
      settings = settingsFor();
      const original = S3Client.prototype.send;
      const destination: FileKey = { ...KEY, fileId: USER };
      const destinationName = `${settings.prefix}${fileKeyName(destination)}`;
      send = vi.spyOn(S3Client.prototype, "send").mockImplementation(function (
        this: S3Client,
        ...args: Parameters<S3Client["send"]>
      ) {
        const [command] = args;
        if (command instanceof PutObjectCommand && command.input.Key === destinationName) {
          // As S3's own error: a code, the object's name and the server's text.
          return Promise.reject(
            Object.assign(new Error(`${SERVER_TEXT}: access denied for ${destinationName}`), {
              name: "AccessDenied",
              Code: "AccessDenied",
              Key: destinationName,
              BucketName: TEST_BUCKET,
              $metadata: { httpStatusCode: 403 },
            }),
          );
        }
        return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      } as S3Client["send"]);
      const store = await createS3FileStore(settings);
      await store.write(KEY, chunks(Buffer.alloc(256 * 1024, 3)), { maxBytes: MAX });

      const error = await rejectionOf(store.copy(KEY, destination));
      expectStoreError(error, "AccessDenied", "PutObject");
      expect(holdsAny(error, [...secretsAndIds(), SERVER_TEXT, settings.prefix, TEST_BUCKET])).toBe(false);
      const getIndex = send.mock.calls.findLastIndex(([command]) => command instanceof GetObjectCommand);
      expect(getIndex).toBeGreaterThanOrEqual(0);
      const output = (await send.mock.results[getIndex]!.value) as { Body: Readable };
      expect(output.Body.destroyed).toBe(true);
      expect(await store.read(destination)).toEqual({ found: false });
      expect((await readText(store, KEY))?.length).toBe(256 * 1024);
    });
  });

  describe("a read's idle timeout (READ_IDLE_TIMEOUT_MS)", () => {
    // Real time: the timer runs beside real sockets, which fake timers would
    // also stop. Each of these waits about ten seconds (slow by design).
    let send: MockInstance<S3Client["send"]> | undefined;
    let prefix: string | undefined;

    afterEach(async () => {
      const clients = new Set((send?.mock.contexts ?? []) as S3Client[]);
      send?.mockRestore();
      send = undefined;
      for (const client of clients) client.destroy();
      if (prefix !== undefined) await removeObjectsUnder(prefix);
      prefix = undefined;
    });

    function lastBody(): Promise<Readable> {
      return (send!.mock.results.at(-1)!.value as Promise<{ Body: Readable }>).then((output) => output.Body);
    }

    const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

    it("is ten seconds", () => {
      expect(READ_IDLE_TIMEOUT_MS).toBe(10_000);
    });

    it("a body that stalls after its headers errors the stream with TimeoutError within about ten seconds, the body destroyed", async () => {
      send = vi.spyOn(S3Client.prototype, "send");
      const store = await stubStore(stub, "stub-stall");
      const result = await store.read(KEY);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const body = await lastBody();
      const started = performance.now();
      const outcome = await Promise.race([
        rejectionOf(buffer(result.stream)),
        sleep(READ_IDLE_TIMEOUT_MS + 4_000).then(() => "still waiting"),
      ]);
      const elapsed = performance.now() - started;
      expect(outcome === "still waiting", "the stream gave up").toBe(false);
      expectStoreError(outcome, "TimeoutError", "GetObject");
      expect(holdsAny(outcome, [...secretsAndIds(), SERVER_TEXT, stub.address])).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(READ_IDLE_TIMEOUT_MS - 500);
      expect(body.destroyed).toBe(true);
      result.stream.destroy();
    }, 30_000);

    it("a reader that stops asking for fifteen seconds is never cut: it then gets every byte of a many-chunk object", async () => {
      useTestKeys();
      const settings = settingsFor();
      prefix = settings.prefix;
      send = vi.spyOn(S3Client.prototype, "send");
      const store = await createS3FileStore(settings);
      const bytes = Buffer.alloc(4 * 1024 * 1024);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
      await store.write(KEY, chunks(bytes), { maxBytes: MAX });

      const result = await store.read(KEY);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const body = await lastBody();
      let isErrored = false;
      result.stream.on("error", () => {
        isErrored = true;
      });
      // Nobody reads: the store's stream fills to its mark and the body is paused.
      await vi.waitFor(() => expect(body.isPaused()).toBe(true));
      await sleep(READ_IDLE_TIMEOUT_MS + 5_000);
      expect(isErrored).toBe(false);
      expect(result.stream.destroyed).toBe(false);
      const read = await buffer(result.stream);
      expect(read.byteLength).toBe(bytes.byteLength);
      expect(sha256(read).equals(sha256(bytes))).toBe(true);
      expect(isErrored).toBe(false);
    }, 40_000);

    it("a body that ends while nobody reads leaves no timer running: read twelve seconds later, every byte, no error", async () => {
      send = vi.spyOn(S3Client.prototype, "send");
      const store = await stubStore(stub, "stub-late-end");
      const result = await store.read(KEY);
      expect(result.found).toBe(true);
      if (!result.found) return;
      let isErrored = false;
      result.stream.on("error", () => {
        isErrored = true;
      });
      const body = await lastBody();
      await vi.waitFor(() => expect(body.readableEnded).toBe(true), { timeout: 5_000 });
      await sleep(READ_IDLE_TIMEOUT_MS + 2_000);
      expect(isErrored).toBe(false);
      expect(result.stream.destroyed).toBe(false);
      expect((await buffer(result.stream)).toString("utf8")).toBe("0123456789");
      expect(isErrored).toBe(false);
    }, 30_000);

    it("a read consumed at once never trips it, during the read or after its end", async () => {
      useTestKeys();
      const settings = settingsFor();
      prefix = settings.prefix;
      send = vi.spyOn(S3Client.prototype, "send");
      const store = await createS3FileStore(settings);
      await store.write(KEY, chunks(Buffer.alloc(1024 * 1024, 5)), { maxBytes: MAX });
      const result = await store.read(KEY);
      expect(result.found).toBe(true);
      if (!result.found) return;
      let isErrored = false;
      result.stream.on("error", () => {
        isErrored = true;
      });
      expect((await buffer(result.stream)).byteLength).toBe(1024 * 1024);
      await sleep(READ_IDLE_TIMEOUT_MS + 1_000);
      expect(isErrored).toBe(false);
    }, 30_000);
  });

  describe("the factory", () => {
    it("builds S3FileStore from s3 settings, running the startup check", async () => {
      useTestKeys();
      const settings = settingsFor();
      try {
        const store = await createFileStore(settings);
        await store.write(KEY, chunks("from the factory"), { maxBytes: MAX });
        expect(await readText(store, KEY)).toBe("from the factory");
      } finally {
        await removeObjectsUnder(settings.prefix);
      }
    });

    it("hands the startup check's refusal to its caller", async () => {
      useTestKeys();
      const bucket = `telflo-missing-${randomUUID().slice(0, 8)}`;
      const error = await rejectionOf(createFileStore(settingsFor({ bucket, prefix: "" })));
      expect((error as Error).message === refusalText("can't be written", bucket, "PutObject", "NoSuchBucket")).toBe(
        true,
      );
    });

    it("refuses a kind it doesn't know, naming no value", async () => {
      await expect(createFileStore({ kind: "azure-blob" } as unknown as FileStoreSettings)).rejects.toThrow(
        "The file store's kind (TELFLO_FILE_STORE) is not one the API knows.",
      );
    });
  });

  describe("the client (source pins)", () => {
    const source = readFileSync(join(workspaceRoot, "apps/api/src/file-store/s3-file-store.ts"), "utf8");
    /** The code without its comments and with its white space folded, so a pin reads only what runs. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\s+/g, " ")
      .replace(/,\s*\}/g, " }");
    /** The options the one client is built with. */
    const clientOptions = /new S3Client\(\{(.*?)\}\);/.exec(code)?.[1] ?? "";

    it("is built in one place, with no credentials and no logger", () => {
      expect(code.match(/new S3Client\(/g)?.length).toBe(1);
      expect(clientOptions === "", "the client's options were found").toBe(false);
      expect(/\bcredentials\b/.test(code), "no credentials").toBe(false);
      expect(/\blogger\b/.test(code), "no logger").toBe(false);
      expect(/console\./.test(code), "nothing printed").toBe(false);
    });

    it("ignores configured endpoint URLs, and has the ruled timeouts and attempts", () => {
      expect(clientOptions.includes("ignoreConfiguredEndpointUrls: true,"), "ignoreConfiguredEndpointUrls").toBe(true);
      expect(clientOptions.includes("maxAttempts: 3,"), "maxAttempts 3").toBe(true);
      expect(
        clientOptions.includes(
          "requestHandler: { connectionTimeout: 2_000, requestTimeout: 4_000, throwOnRequestTimeout: true }",
        ),
        "the request handler's timeouts",
      ).toBe(true);
      expect(/socketTimeout/.test(code), "no socket timeout").toBe(false);
    });

    it("sets no encryption header (the bucket's default)", () => {
      expect(/ServerSideEncryption|SSEKMS|SSECustomer/.test(code)).toBe(false);
    });

    it("no other production file names the AWS SDK", () => {
      const skipped = new Set(["node_modules", "dist", "build", "coverage", ".react-router", "test-results"]);
      const sources = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
          return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
        });
      const all = ["apps", "packages"].flatMap((directory) => sources(join(workspaceRoot, directory)));
      expect(all.some((path) => path.endsWith("/apps/api/src/file-store/s3-file-store.ts"))).toBe(true);
      const offenders = all
        .filter((path) => !path.endsWith("/apps/api/src/file-store/s3-file-store.ts"))
        .filter((path) => /@aws-sdk\//.test(readFileSync(path, "utf8")));
      expect(offenders).toEqual([]);
    });
  });
});

// --- The tests' environment -----------------------------------------------

const CHAIN_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL_STS",
];

/** Read as this file loads, before any test stubs a key. Names and booleans only. */
const ENVIRONMENT_AT_LOAD = {
  notBlank: CHAIN_VARIABLES.filter((name) => process.env[name] !== ""),
  filesMissing:
    process.env.AWS_CONFIG_FILE?.startsWith("/nonexistent/") === true &&
    process.env.AWS_SHARED_CREDENTIALS_FILE?.startsWith("/nonexistent/") === true,
  metadataDisabled: process.env.AWS_EC2_METADATA_DISABLED === "true",
  local: process.env.TELFLO_FILE_STORE === "local",
};

describe("the tests' environment holds no AWS identity (vitest.setup.ts)", () => {
  it("in this worker: every chain variable blank, the shared files missing, no metadata service, the local store", () => {
    expect(ENVIRONMENT_AT_LOAD).toEqual({
      notBlank: [],
      filesMissing: true,
      metadataDisabled: true,
      local: true,
    });
  });

  it("blanks a developer's own AWS_ variables, whatever they are, before any test runs", () => {
    const canary = `scrub-canary-${randomUUID()}`;
    const planted: Record<string, string> = {
      AWS_ACCESS_KEY_ID: canary,
      AWS_SECRET_ACCESS_KEY: canary,
      AWS_SESSION_TOKEN: canary,
      AWS_PROFILE: canary,
      AWS_ROLE_ARN: canary,
      AWS_WEB_IDENTITY_TOKEN_FILE: canary,
      AWS_ENDPOINT_URL_S3: canary,
      AWS_REGION: canary,
      AWS_CA_BUNDLE: canary,
      AWS_A_VARIABLE_NO_LIST_NAMES: canary,
      AWS_CONFIG_FILE: canary,
      AWS_SHARED_CREDENTIALS_FILE: canary,
      AWS_EC2_METADATA_DISABLED: "false",
      TELFLO_FILE_STORE: "s3",
    };
    // The setup itself, run in a child process with those planted; it
    // reports names and booleans only.
    const script = `
      const canary = process.argv[1];
      await import(${JSON.stringify(new URL("../../../../vitest.setup.ts", import.meta.url).href)});
      const awsNames = Object.keys(process.env).filter((name) => name.startsWith("AWS_"));
      console.log(JSON.stringify({
        holdsCanary: Object.values(process.env).some((value) => value?.includes(canary)),
        notBlank: awsNames.filter((name) => process.env[name] !== "" && !["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_EC2_METADATA_DISABLED"].includes(name)).sort(),
        filesMissing: process.env.AWS_CONFIG_FILE.startsWith("/nonexistent/") && process.env.AWS_SHARED_CREDENTIALS_FILE.startsWith("/nonexistent/"),
        metadataDisabled: process.env.AWS_EC2_METADATA_DISABLED === "true",
        local: process.env.TELFLO_FILE_STORE === "local",
      }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script, canary],
      {
        cwd: workspaceRoot,
        env: { ...process.env, ...planted },
        encoding: "utf8",
      },
    );
    const report = JSON.parse(output.trim().split("\n").at(-1)!) as unknown;
    expect(report).toEqual({
      holdsCanary: false,
      notBlank: [],
      filesMissing: true,
      metadataDisabled: true,
      local: true,
    });
  });
});
