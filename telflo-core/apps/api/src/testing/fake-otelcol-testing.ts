import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// The collector tester in memory, for tests only (D14a Task 6). Built on
// node:http, as the fake validator is (fake-otelcol-validator.ts). It never
// ships: .dockerignore leaves apps/api/src/testing out of the images, and a
// lint rule keeps production code from importing it.
//
// It checks the contract both ways: every request it receives and every
// reply it sends is validated against services/otelcol-testing/openapi.yaml,
// with ajv's JSON Schema 2020-12 dialect (and the base64 the file names with
// `contentEncoding`, which ajv only annotates). A mismatch is a violation:
// kept until takeViolations() reads it, and close() rejects while any is
// unread, so a test that forgets to look still fails. The request is then
// answered as the real tester would (a 400, 401, 404 or 413), so the client
// under test sees a realistic reply.
//
// It runs no collector. It answers by the TEXT, so the browser tests, which
// run in parallel and share one fake, each get the answer their own text
// asks for, by a marker line `# fake-otelcol-testing: <marker>`:
//
// - none: succeeded, its output the input's own bytes (and its decoded
//   input the same), the strategy `otlp`;
// - `collector-failed`: failed, `collector_failed`, with the collector's logs;
// - `refused`: failed, `refused`, with a C-005 compatibility refusal and no
//   collector started;
// - `slow`: held, unanswered, until releaseHeld() (or close()); a test waits
//   for it with waitForHeld(), a condition, never a timer. Released, it is
//   answered as the rest of its text asks. Each of the three takes a
//   `contains` that narrows it to the held runs whose text holds it, so a
//   browser test, sharing the fake with others in parallel, counts and
//   releases only its own (D14a Ruling 36; the browser tests' control
//   route, support/fake-otelcol-testing.ts);
// - `busy`, `starting`, `unavailable`, `version-unavailable`: 503
//   `tester_busy`, `tester_starting`, `tester_unavailable`,
//   `version_unavailable`;
// - `changes-attributes`: succeeded, as with none, but its output changes
//   every record's attributes (log records, spans, every metric type's data
//   points): `e2e.added` set to "yes", an existing `e2e.changed` set to
//   "after", `e2e.removed` removed, written as compact JSON as the real
//   tester writes it; its decoded input still the input's bytes. An input
//   that isn't one OTLP/JSON document, or an output past 10 MiB, comes back
//   unchanged (D15b Preflight ruling 6, for Compare's chips).
//
// Its health is setHealth()'s: `ready` (200) by default, `starting` or
// `unavailable` (503, kwok starting or failed). The API's tests push other
// answers with nextFault, a queue: each run request takes the first fault
// waiting, if any.

/** A fixed, public test credential: 32 bytes and more. */
export const FAKE_OTELCOL_TESTING_SECRET = "telflo-fake-otelcol-testing-secret-0123456789";

/** The start of a marker line; the marker follows it. */
export const FAKE_OTELCOL_TESTING_MARKER_PREFIX = "# fake-otelcol-testing: ";

export const FAKE_OTELCOL_TESTING_MARKERS = [
  "collector-failed",
  "refused",
  "slow",
  "busy",
  "starting",
  "unavailable",
  "version-unavailable",
  "changes-attributes",
] as const;

export type FakeOtelcolTestingMarker = (typeof FAKE_OTELCOL_TESTING_MARKERS)[number];

/** The line a text holds to be answered as `marker` says. */
export function fakeOtelcolTestingMarker(marker: FakeOtelcolTestingMarker): string {
  return `${FAKE_OTELCOL_TESTING_MARKER_PREFIX}${marker}`;
}

/** What GET /testing/v1/health answers: setHealth(). */
export type FakeOtelcolTestingHealth = "ready" | "starting" | "unavailable";

/**
 * One each, for the run requests that follow, in the order queued (GET
 * /health is never faulted; setHealth decides it):
 * - `hang`: never answered (until close());
 * - `reset`: the connection is reset before anything is read;
 * - `error_500`: 500 `internal_error`;
 * - `tester_busy`, `tester_starting`, `tester_unavailable`,
 *   `version_unavailable`: their 503s;
 * - `version_retired`: 409; `version_unknown`, `invalid_request`: 400;
 * - `payload_too_large`, `input_too_large`: their 413s;
 * - `malformed_reply`: the answer loses its `status` field. The fake's own
 *   reply validation records it as a violation.
 */
export type FakeOtelcolTestingFault =
  | "hang"
  | "reset"
  | "error_500"
  | "tester_busy"
  | "tester_starting"
  | "tester_unavailable"
  | "version_unavailable"
  | "version_retired"
  | "version_unknown"
  | "invalid_request"
  | "payload_too_large"
  | "input_too_large"
  | "malformed_reply";

/** A run request the fake read, once authenticated and routed. Its input is kept as a size and a hash only. */
export interface FakeOtelcolTestingRequest {
  runId: string | undefined;
  /** The body's `yaml`, or undefined when the body had none. */
  yaml: string | undefined;
  pipeline: string | undefined;
  signal: string | undefined;
  durationSeconds: number | undefined;
  distribution: string | undefined;
  version: string | undefined;
  /** The input's decoded size and SHA-256, when it was standard base64. */
  input: { sizeBytes: number; sha256: string } | undefined;
}

export interface FakeOtelcolTesting {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  secret: string;
  /** Queues a fault for the next run request that has none yet. */
  nextFault(fault: FakeOtelcolTestingFault): void;
  /** What GET /testing/v1/health answers from now on. */
  setHealth(health: FakeOtelcolTestingHealth): void;
  /** How many `slow` runs it holds now: only those whose text holds `contains`, when given. */
  heldCount(contains?: string): number;
  /** Resolves once it holds at least `count` `slow` runs (at once, if it does): only those whose text holds `contains`, when given. */
  waitForHeld(count: number, contains?: string): Promise<void>;
  /**
   * Answers every `slow` run it holds, as the rest of its text asks, or only
   * those whose text holds `contains`, when given; returns how many.
   */
  releaseHeld(contains?: string): number;
  /** Every run request since the last call, in order (at most the last 200); clears them. */
  takeRequests(): FakeOtelcolTestingRequest[];
  /** Every contract violation since the last call, in order; clears them. */
  takeViolations(): string[];
  /** Closes the server and every connection (a held run's too); rejects if a violation is unread. */
  close(): Promise<void>;
}

export interface FakeOtelcolTestingOptions {
  /** Default FAKE_OTELCOL_TESTING_SECRET. */
  secret?: string;
  /** The port on 127.0.0.1. Default 0, any free one; the browser tests' fixes one (28087). */
  port?: number;
  /**
   * Told each violation as it is recorded, which is still kept for
   * takeViolations() and close(). The browser tests' entry writes them to
   * stderr and to a file their teardown reads.
   */
  onViolation?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// The contract: openapi.yaml, read once and compiled with ajv.

const OPENAPI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../services/otelcol-testing/openapi.yaml");

/** The $id the file's schemas are registered under; never fetched. */
const SCHEMAS_ID = "https://otelcol-testing.telflo.invalid/openapi.yaml";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ContractResponse {
  headers: { name: string; required: boolean; validate: ValidateFunction }[];
  content: { mediaType: string; validate: ValidateFunction } | undefined;
}

interface ContractOperation {
  operationId: string;
  method: string;
  path: string;
  requestBody: { mediaType: string; validate: ValidateFunction } | undefined;
  responses: Map<string, ContractResponse>;
  isSecured: boolean;
}

interface Contract {
  operations: ContractOperation[];
  /** components.schemas.Error, for replies to requests no operation matches. */
  errorReply: ValidateFunction;
  /** components.responses.Unauthorized, for a 401 to a request no operation matches. */
  unauthorized: ContractResponse;
}

/** A deep copy of `node` whose `$ref`s to components.schemas point at the registered schemas. */
function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== "object") return node;
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = /^#\/components\/schemas\/([^/]+)$/.exec(value)?.[1];
      if (name === undefined) throw new Error(`openapi.yaml: unsupported schema $ref ${value}`);
      copy[key] = `${SCHEMAS_ID}#/$defs/${name}`;
    } else {
      copy[key] = rewriteRefs(value);
    }
  }
  return copy;
}

function asObject(node: Json | undefined, where: string): JsonObject {
  if (node === null || node === undefined || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`openapi.yaml: ${where} isn't an object`);
  }
  return node;
}

/** Follows a `$ref` to components.responses; anything else as it is. */
function dereference(document: JsonObject, node: Json | undefined, where: string): JsonObject {
  const object = asObject(node, where);
  const ref = object.$ref;
  if (typeof ref !== "string") return object;
  const match = /^#\/components\/responses\/([^/]+)$/.exec(ref);
  if (match === null) throw new Error(`openapi.yaml: unsupported $ref ${ref} at ${where}`);
  const components = asObject(document.components, "components");
  return asObject(asObject(components.responses, "responses")[match[1] as string], ref);
}

function loadContract(): Contract {
  const document = asObject(parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as Json, "the document");
  const components = asObject(document.components, "components");

  // The file's if/then/else names `properties` without `type: object`
  // beside it, and `strategy`'s enum holds null with no `type`, which
  // strictTypes would refuse; its `then` requires `error`, which only the
  // schema around it defines, which strictRequired would refuse. Every other
  // strict check stays.
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  ajv.addSchema({ $id: SCHEMAS_ID, $defs: rewriteRefs(asObject(components.schemas, "components.schemas")) });
  const compile = (schema: Json | undefined, where: string) =>
    ajv.compile(asObject(rewriteRefs(asObject(schema, where)), where));

  const responseOf = (raw: Json | undefined, where: string): ContractResponse => {
    const response = dereference(document, raw, where);
    const headers = Object.entries(response.headers === undefined ? {} : asObject(response.headers, "headers")).map(
      ([name, header]) => ({
        name: name.toLowerCase(),
        required: asObject(header, name).required === true,
        validate: compile(asObject(header, name).schema, `${where} header ${name}`),
      }),
    );
    let content: ContractResponse["content"];
    if (response.content !== undefined) {
      const [mediaType, media] = Object.entries(asObject(response.content, "content"))[0] as [string, Json];
      content = { mediaType, validate: compile(asObject(media, mediaType).schema, where) };
    }
    return { headers, content };
  };

  const globalSecurity = document.security;
  const operations: ContractOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(asObject(document.paths, "paths"))) {
    if (path.includes("{")) throw new Error(`openapi.yaml: the fake takes no path parameters (${path})`);
    const pathItem = asObject(rawPathItem, path);
    for (const method of ["get", "put", "delete", "post", "patch", "head", "options"]) {
      if (pathItem[method] === undefined) continue;
      const operation = asObject(pathItem[method], `${path} ${method}`);
      const operationId = String(operation.operationId);
      if (operation.parameters !== undefined) throw new Error(`openapi.yaml: the fake takes no parameters (${operationId})`);

      let requestBody: ContractOperation["requestBody"];
      if (operation.requestBody !== undefined) {
        const content = asObject(asObject(operation.requestBody, "requestBody").content, `${operationId} requestBody`);
        const [mediaType, media] = Object.entries(content)[0] as [string, Json];
        requestBody = { mediaType, validate: compile(asObject(media, mediaType).schema, `${operationId} requestBody`) };
      }

      const responses = new Map<string, ContractResponse>();
      for (const [status, raw] of Object.entries(asObject(operation.responses, `${operationId} responses`))) {
        responses.set(status, responseOf(raw, `${operationId} ${status}`));
      }

      const security = operation.security ?? globalSecurity;
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        requestBody,
        responses,
        isSecured: Array.isArray(security) && security.length > 0,
      });
    }
  }
  return {
    operations,
    errorReply: compile({ $ref: "#/components/schemas/Error" }, "Error"),
    unauthorized: responseOf({ $ref: "#/components/responses/Unauthorized" }, "Unauthorized"),
  };
}

let contract: Contract | undefined;

/** The contract, compiled once per test process. */
function theContract(): Contract {
  contract ??= loadContract();
  return contract;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`).join("; ");
}

/** The media type of a Content-Type header, lowercased, without parameters. */
function mediaTypeOf(value: string | undefined): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase();
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Standard, padded base64 decodes to bytes that encode back to the same text. */
function decodeBase64(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : undefined;
}

/** The contract's `base64` fields of a reply, each checked as standard base64 (`contentEncoding`). */
function badBase64Fields(body: Json): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const bad: string[] = [];
  for (const field of ["output", "decodedInput"]) {
    const file = body[field];
    if (file === null || typeof file !== "object" || Array.isArray(file)) continue;
    const base64 = file.base64;
    if (typeof base64 === "string" && decodeBase64(base64) === undefined) bad.push(`/${field}/base64`);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// The answers.

/** The real tester's body cap: 16 MiB. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Bodies past this aren't read at all: the fake drops the connection. */
const MAX_READ_BYTES = 24 * 1024 * 1024;
/** The real tester's limit on `yaml`: the platform's. */
const MAX_YAML_CHARACTERS = 262_144;
/** The real tester's limit on the input, decoded: 10 MiB. */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
/** How many requests takeRequests() keeps, so a browser run's fake doesn't grow without bound. */
const MAX_KEPT_REQUESTS = 200;

const RUNS_PATH = "/testing/v1/runs";

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Json;
}

/** A run request the contract accepts, as the fake reads it. */
interface RunRequest {
  yaml: string;
  durationSeconds: number;
  version: string;
  input: Buffer;
}

function errorReply(status: number, code: string, message: string): Reply {
  return { status, headers: { "content-type": "application/json" }, body: { error: { code, message } } };
}

/** The 503s a marker asks for. */
const MARKER_REPLIES: Partial<Record<FakeOtelcolTestingMarker, () => Reply>> = {
  busy: () => errorReply(503, "tester_busy", "Every run slot is busy. Retry shortly."),
  starting: () => errorReply(503, "tester_starting", "The tester is starting. Retry shortly."),
  unavailable: () => errorReply(503, "tester_unavailable", "The tester is unavailable and restarting."),
  "version-unavailable": () => errorReply(503, "version_unavailable", "This tester doesn't hold that collector version."),
};

const FAULT_REPLIES: Partial<Record<FakeOtelcolTestingFault, () => Reply>> = {
  error_500: () => errorReply(500, "internal_error", "Internal server error."),
  tester_busy: () => MARKER_REPLIES.busy!(),
  tester_starting: () => MARKER_REPLIES.starting!(),
  tester_unavailable: () => MARKER_REPLIES.unavailable!(),
  version_unavailable: () => MARKER_REPLIES["version-unavailable"]!(),
  version_retired: () =>
    errorReply(409, "version_retired", "This collector version is retired: pick an offered version to run this test."),
  version_unknown: () => errorReply(400, "version_unknown", "The catalogue lists no such version of otelcol-contrib."),
  invalid_request: () => errorReply(400, "invalid_request", "The request body must be a JSON object."),
  payload_too_large: () => errorReply(413, "payload_too_large", "The request body is larger than 16 MiB."),
  input_too_large: () => errorReply(413, "input_too_large", "The input is larger than 10 MiB."),
};

const notFound = (): Reply => errorReply(404, "not_found", "Not found.");
const unauthorized = (): Reply => ({
  ...errorReply(401, "unauthorized", "Missing or invalid credentials."),
  headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
});

function healthReply(health: FakeOtelcolTestingHealth): Reply {
  const headers = { "content-type": "application/json" };
  switch (health) {
    case "ready":
      return { status: 200, headers, body: { status: "ok", kwok: "ready" } };
    case "starting":
      return { status: 503, headers, body: { status: "starting", kwok: "starting" } };
    case "unavailable":
      return { status: 503, headers, body: { status: "unavailable", kwok: "failed" } };
  }
}

/** The markers `yaml` holds, each on a line of its own. */
function markersOf(yaml: string): Set<FakeOtelcolTestingMarker> {
  const markers = new Set<FakeOtelcolTestingMarker>();
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FAKE_OTELCOL_TESTING_MARKER_PREFIX)) continue;
    const marker = trimmed.slice(FAKE_OTELCOL_TESTING_MARKER_PREFIX.length).trim();
    if ((FAKE_OTELCOL_TESTING_MARKERS as readonly string[]).includes(marker)) markers.add(marker as FakeOtelcolTestingMarker);
  }
  return markers;
}

const READY_LOG = "2026-10-09T10:00:00.000Z\tinfo\tservice/service.go\tEverything is ready. Begin running and processing data.\n";

const R001: JsonObject = {
  id: "R-001",
  severity: "info",
  message:
    "Your receivers were replaced with a sandbox OTLP/HTTP source. The data flowing through your processor chain comes from the fixture you selected, not from the original receivers.",
  details: { test_receiver: "otlp/test_in" },
};

/** The attribute keys `changes-attributes` adds, changes and removes on every record. */
export const FAKE_OTELCOL_TESTING_ATTRIBUTES = { added: "e2e.added", changed: "e2e.changed", removed: "e2e.removed" } as const;

/** The real tester's output cap: 10 MiB. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function isObject(node: Json | undefined): node is JsonObject {
  return node !== null && node !== undefined && typeof node === "object" && !Array.isArray(node);
}

/** The elements of `parent[key]` that are objects (none when it isn't an array). */
function objectsAt(parent: JsonObject, key: string): JsonObject[] {
  const value = parent[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** Every record of an OTLP/JSON document, each given to `visit`: log records, spans, every metric type's data points. */
function forEachRecord(document: JsonObject, visit: (record: JsonObject) => void): void {
  for (const resource of objectsAt(document, "resourceLogs")) {
    for (const scope of objectsAt(resource, "scopeLogs")) objectsAt(scope, "logRecords").forEach(visit);
  }
  for (const resource of objectsAt(document, "resourceSpans")) {
    for (const scope of objectsAt(resource, "scopeSpans")) objectsAt(scope, "spans").forEach(visit);
  }
  for (const resource of objectsAt(document, "resourceMetrics")) {
    for (const scope of objectsAt(resource, "scopeMetrics")) {
      for (const metric of objectsAt(scope, "metrics")) {
        for (const type of ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]) {
          const data = metric[type];
          if (isObject(data)) objectsAt(data, "dataPoints").forEach(visit);
        }
      }
    }
  }
}

/** One record's attributes changed as `changes-attributes` says, in place. */
function changeAttributes(record: JsonObject): void {
  const { added, changed, removed } = FAKE_OTELCOL_TESTING_ATTRIBUTES;
  const attributes = (Array.isArray(record.attributes) ? record.attributes : []).filter(
    (attribute) => !(isObject(attribute) && (attribute.key === removed || attribute.key === added)),
  );
  for (const attribute of attributes) {
    if (isObject(attribute) && attribute.key === changed) attribute.value = { stringValue: "after" };
  }
  attributes.push({ key: added, value: { stringValue: "yes" } });
  record.attributes = attributes;
}

/** The output `changes-attributes` writes for `input`, or the input itself when it isn't one OTLP/JSON document or the output would pass 10 MiB. */
function attributesChanged(input: Buffer): Buffer {
  let document: Json;
  try {
    document = JSON.parse(input.toString("utf8")) as Json;
  } catch {
    return input;
  }
  if (!isObject(document) || !["resourceLogs", "resourceSpans", "resourceMetrics"].some((key) => Array.isArray(document[key]))) {
    return input;
  }
  forEachRecord(document, changeAttributes);
  const output = Buffer.from(JSON.stringify(document), "utf8");
  return output.byteLength > MAX_OUTPUT_BYTES ? input : output;
}

/** The answer the fake gives a run (the module's comment says how), its markers already read. */
function answerRun(run: RunRequest, markers: Set<FakeOtelcolTestingMarker>): Reply {
  for (const [marker, reply] of Object.entries(MARKER_REPLIES) as [FakeOtelcolTestingMarker, () => Reply][]) {
    if (markers.has(marker)) return reply();
  }
  const headers = { "content-type": "application/json" };
  const holdMs = run.durationSeconds * 1000;
  if (markers.has("refused")) {
    const message = "the geoip processor reads a database file, which the sandbox doesn't offer";
    return {
      status: 200,
      headers,
      body: {
        status: "failed",
        error: { code: "refused", message },
        strategy: null,
        kwokEnabled: false,
        collectorVersion: run.version,
        logs: "",
        mutatedYaml: null,
        mutations: [],
        compatibility: [{ id: "C-005", severity: "refuse", component: "processors::geoip", message, details: {} }],
        output: null,
        decodedInput: null,
        timings: { totalMs: 3, readyMs: null, informerMs: null, replayMs: null, holdMs: null, stopMs: null },
      },
    };
  }
  if (markers.has("collector-failed")) {
    return {
      status: 200,
      headers,
      body: {
        status: "failed",
        error: { code: "collector_failed", message: "The collector exited before it was ready." },
        strategy: "otlp",
        kwokEnabled: false,
        collectorVersion: run.version,
        logs: "2026-10-09T10:00:00.000Z\terror\tcollector exited: failed to build pipelines\n",
        mutatedYaml: run.yaml,
        mutations: [R001],
        compatibility: [],
        output: null,
        decodedInput: null,
        timings: { totalMs: 420, readyMs: null, informerMs: null, replayMs: null, holdMs: null, stopMs: 15 },
      },
    };
  }
  const base64 = run.input.toString("base64");
  const output = markers.has("changes-attributes") ? attributesChanged(run.input) : run.input;
  return {
    status: 200,
    headers,
    body: {
      status: "succeeded",
      strategy: "otlp",
      kwokEnabled: false,
      collectorVersion: run.version,
      logs: `${READY_LOG}[replay] 1 of 1 payloads sent\n`,
      mutatedYaml: run.yaml,
      mutations: [R001],
      compatibility: [],
      output:
        output.byteLength === 0 ? null : { base64: output.toString("base64"), bytesOnDisk: output.byteLength, truncated: false },
      decodedInput: { base64, truncated: false },
      timings: { totalMs: holdMs + 60, readyMs: 20, informerMs: null, replayMs: 10, holdMs, stopMs: 30 },
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_READ_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Starts the fake. Close it after the tests: it holds a listening socket,
 * and close() is where an unread violation fails the run.
 */
export async function startFakeOtelcolTesting(options: FakeOtelcolTestingOptions = {}): Promise<FakeOtelcolTesting> {
  const { operations, errorReply: errorEnvelope, unauthorized: unauthorizedResponse } = theContract();
  const secret = options.secret ?? FAKE_OTELCOL_TESTING_SECRET;
  const violations: string[] = [];
  const requests: FakeOtelcolTestingRequest[] = [];
  const faults: FakeOtelcolTestingFault[] = [];
  let health: FakeOtelcolTestingHealth = "ready";
  /** The `slow` runs it holds, each with its text: each answers when released. */
  const held = new Map<() => void, string>();
  const heldWaiters = new Set<{ count: number; contains: string | undefined; resolve: () => void }>();

  /** The held runs' releases, or only those whose text holds `contains`. */
  function heldMatching(contains: string | undefined): (() => void)[] {
    return [...held].filter(([, yaml]) => contains === undefined || yaml.includes(contains)).map(([release]) => release);
  }

  function violation(message: string): void {
    violations.push(message);
    options.onViolation?.(message);
  }

  function checkResponse(where: string, documented: ContractResponse, reply: Reply): void {
    for (const header of documented.headers) {
      const value = reply.headers[header.name];
      if (value === undefined) {
        if (header.required) violation(`${where}: header ${header.name} is missing`);
      } else if (!header.validate(value)) {
        violation(`${where}: header ${header.name} ${describeErrors(header.validate.errors)}`);
      }
    }
    if (documented.content === undefined) return;
    if (mediaTypeOf(reply.headers["content-type"]) !== documented.content.mediaType) {
      violation(`${where}: Content-Type isn't ${documented.content.mediaType}`);
    }
    if (!documented.content.validate(reply.body)) {
      violation(`${where} body: ${describeErrors(documented.content.validate.errors)}`);
    }
    for (const field of badBase64Fields(reply.body)) violation(`${where} body: ${field} isn't standard base64`);
  }

  /** Records the reply's violations of the contract: its status, headers and body. */
  function checkReply(operation: ContractOperation | undefined, reply: Reply): void {
    if (operation === undefined) {
      // A request no operation matches: the file's 401 or 404 envelope.
      if (reply.status === 401) checkResponse("reply 401", unauthorizedResponse, reply);
      else if (!errorEnvelope(reply.body)) violation(`reply ${reply.status}: ${describeErrors(errorEnvelope.errors)}`);
      return;
    }
    const where = `${operation.operationId} reply ${reply.status}`;
    const documented = operation.responses.get(String(reply.status));
    if (documented === undefined) {
      violation(`${where}: the status isn't documented`);
      return;
    }
    checkResponse(where, documented, reply);
  }

  /**
   * The request's violations of the run's contract, recorded, and the real
   * tester's answer when it refuses it (the body's size, JSON, fields, the
   * text's length and the input's), else the run it reads.
   */
  function readRunRequest(
    operation: ContractOperation,
    request: IncomingMessage,
    body: Buffer,
  ): { reply: Reply; parsed: Json | undefined } | { run: RunRequest; parsed: Json } {
    const where = `${operation.operationId} request`;
    if (body.length > MAX_BODY_BYTES) {
      violation(`${where}: the body is larger than 16 MiB`);
      return { reply: errorReply(413, "payload_too_large", "The request body is larger than 16 MiB."), parsed: undefined };
    }
    const contentType = singleHeader(request.headers, "content-type");
    if (operation.requestBody === undefined || mediaTypeOf(contentType) !== operation.requestBody.mediaType) {
      violation(`${where}: Content-Type isn't application/json`);
      return { reply: errorReply(400, "invalid_request", "Content-Type must be application/json."), parsed: undefined };
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Json;
    } catch {
      violation(`${where}: the body isn't JSON`);
      return { reply: errorReply(400, "invalid_request", "The request body must be a JSON object."), parsed: undefined };
    }
    const fields = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as JsonObject;
    const inputBase64 = (fields.input as JsonObject | null | undefined)?.base64;
    const input = typeof inputBase64 === "string" ? decodeBase64(inputBase64) : undefined;
    let isValid = operation.requestBody.validate(parsed);
    if (!isValid) violation(`${where} body: ${describeErrors(operation.requestBody.validate.errors)}`);
    if (typeof inputBase64 === "string" && input === undefined) {
      violation(`${where} body: /input/base64 isn't standard base64`);
      isValid = false;
    }
    if (!isValid) {
      const yaml = fields.yaml;
      if (typeof yaml === "string" && [...yaml].length > MAX_YAML_CHARACTERS) {
        return { reply: errorReply(413, "payload_too_large", "The yaml is longer than 262,144 characters."), parsed };
      }
      return { reply: errorReply(400, "invalid_request", "The request body doesn't match the API."), parsed };
    }
    if (input === undefined || input.byteLength > MAX_INPUT_BYTES) {
      violation(`${where}: the input is larger than 10 MiB decoded`);
      return { reply: errorReply(413, "input_too_large", "The input is larger than 10 MiB."), parsed };
    }
    return {
      run: {
        yaml: fields.yaml as string,
        durationSeconds: fields.durationSeconds as number,
        version: fields.version as string,
        input,
      },
      parsed,
    };
  }

  function send(response: ServerResponse, reply: Reply): void {
    response.writeHead(reply.status, reply.headers);
    response.end(JSON.stringify(reply.body));
  }

  function keep(parsed: Json | undefined): void {
    const fields = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as JsonObject;
    const text = (value: Json | undefined) => (typeof value === "string" ? value : undefined);
    const base64 = text((fields.input as JsonObject | null | undefined)?.base64);
    const input = base64 === undefined ? undefined : decodeBase64(base64);
    requests.push({
      runId: text(fields.runId),
      yaml: text(fields.yaml),
      pipeline: text(fields.pipeline),
      signal: text(fields.signal),
      durationSeconds: typeof fields.durationSeconds === "number" ? fields.durationSeconds : undefined,
      distribution: text(fields.distribution),
      version: text(fields.version),
      input:
        input === undefined
          ? undefined
          : { sizeBytes: input.byteLength, sha256: createHash("sha256").update(input).digest("hex") },
    });
    if (requests.length > MAX_KEPT_REQUESTS) requests.shift();
  }

  function notifyHeld(): void {
    for (const waiter of heldWaiters) {
      if (heldMatching(waiter.contains).length >= waiter.count) {
        heldWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-otelcol-testing.invalid");
    const method = request.method ?? "GET";
    const operation = operations.find((candidate) => candidate.path === url.pathname && candidate.method === method);

    if (operation !== undefined && !operation.isSecured) {
      // GET /health: no secret, never faulted.
      const body = await readBody(request);
      if (body !== undefined && body.length > 0) violation(`${operation.operationId} request: has a body, which it doesn't take`);
      if (url.search !== "") violation(`${operation.operationId} request: has a query, which it doesn't take`);
      const reply = healthReply(health);
      checkReply(operation, reply);
      send(response, reply);
      return;
    }

    const isRun = operation !== undefined && operation.path === RUNS_PATH;
    if (isRun && faults[0] === "reset") {
      faults.shift();
      request.socket.resetAndDestroy();
      return;
    }

    // Authentication comes before routing and before the body, as the real
    // tester's does. A request without the Bearer scheme breaks the security
    // scheme; a wrong secret is a documented 401.
    const token = /^bearer +(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      violation(`${operation?.operationId ?? `${method} ${url.pathname}`} request: no Authorization: Bearer header`);
    }
    if (token !== secret) {
      request.resume();
      const reply = unauthorized();
      checkReply(operation, reply);
      send(response, reply);
      return;
    }
    if (operation === undefined) {
      request.resume();
      violation(`${method} ${url.pathname}: the route isn't documented`);
      const reply = notFound();
      checkReply(undefined, reply);
      send(response, reply);
      return;
    }
    if (url.search !== "") violation(`${operation.operationId} request: has a query, which it doesn't take`);

    const body = await readBody(request);
    if (body === undefined) {
      violation(`${operation.operationId} request: the body is larger than the fake reads`);
      request.socket.destroy();
      return;
    }
    const read = readRunRequest(operation, request, body);
    keep(read.parsed);

    const fault = faults.shift();
    if (fault === "hang") return;

    const answer = (): Reply => {
      const faultReply = fault === undefined ? undefined : FAULT_REPLIES[fault];
      if (faultReply !== undefined) return faultReply();
      if ("reply" in read) return read.reply;
      let reply = answerRun(read.run, markersOf(read.run.yaml));
      if (fault === "malformed_reply" && reply.status === 200) {
        const { status: _dropped, ...rest } = reply.body as JsonObject;
        reply = { ...reply, body: rest };
      }
      return reply;
    };

    if (fault === undefined && "run" in read && markersOf(read.run.yaml).has("slow")) {
      const release = (): void => {
        const reply = answer();
        checkReply(operation, reply);
        if (!response.destroyed) send(response, reply);
      };
      held.set(release, read.run.yaml);
      response.once("close", () => held.delete(release));
      notifyHeld();
      return;
    }

    const reply = answer();
    checkReply(operation, reply);
    send(response, reply);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      violation(`the fake failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) send(response, errorReply(500, "internal_error", "Internal server error."));
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    nextFault(fault) {
      faults.push(fault);
    },
    setHealth(next) {
      health = next;
    },
    heldCount(contains) {
      return heldMatching(contains).length;
    },
    waitForHeld(count, contains) {
      return new Promise<void>((resolve) => {
        heldWaiters.add({ count, contains, resolve });
        notifyHeld();
      });
    },
    releaseHeld(contains) {
      const releasing = heldMatching(contains);
      for (const release of releasing) held.delete(release);
      for (const release of releasing) release();
      return releasing.length;
    },
    takeRequests() {
      return requests.splice(0);
    },
    takeViolations() {
      return violations.splice(0);
    },
    async close() {
      held.clear();
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
      if (violations.length > 0) {
        throw new Error(`The fake otelcol-testing saw contract violations no test read:\n${violations.join("\n")}`);
      }
    },
  };
}
