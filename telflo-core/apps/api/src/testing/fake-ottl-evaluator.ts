import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// The OTTL evaluator in memory, for tests only (D15a Task 5; plan Preflight
// ruling 28). Built on node:http, as the fake tester is
// (fake-otelcol-testing.ts). It never ships: .dockerignore leaves
// apps/api/src/testing out of the images, and a lint rule keeps production
// code from importing it.
//
// It checks the contract both ways: every request it receives and every
// reply it sends is validated against services/ottl-evaluator/openapi.yaml,
// with ajv's JSON Schema 2020-12 dialect (and the output's base64, which the
// file names with `contentEncoding` and ajv only annotates). A mismatch is a
// violation: kept until takeViolations() reads it, and close() rejects while
// any is unread, so a test that forgets to look still fails. The request is
// then answered as the real evaluator would (a 400, 401, 404 or 413), so the
// client under test sees a realistic reply.
//
// It runs no OTTL. It answers by the REQUEST, so the browser tests, which run
// in parallel and share one fake, each get the answer their own rules ask
// for, by a marker `fake-ottl-evaluator: <marker>` anywhere in a rule's
// pattern, condition or expression (inside an OTTL string literal, so the
// condition still parses for the real evaluator: `body == "fake-ottl-evaluator: fail"`):
//
// - none: the rule passes (with the truncation advisory for an output rule
//   when the output was cut at 10 MiB);
// - `fail`: the rule fails, with its kind's detail (no_match for a contains
//   rule, unexpected_match for a not-contains rule, record_mismatch for an
//   OTTL rule, distinct_mismatch for a distinct one);
// - `error`: the rule fails with its own error ("Not checked: …");
// - `invalid`: at validate, the rule isn't valid ("OTTL syntax error: …",
//   "Invalid regex: …"); at evaluate, the same words as the rule's error;
// - `busy`: the whole request is 503 `evaluator_busy`;
// - `unavailable`: the whole request is 500 `internal_error` (the evaluator
//   couldn't answer).
//
// Validate also refuses an OTTL context the signal doesn't allow, in the
// evaluator's words. Lint (D25 Task 3) answers each text by the same
// markers in it: none, valid; `invalid`, "OTTL syntax error: …"; `busy` and
// `unavailable`, the whole request; and a text calling one of the transform
// processor's own functions (FAKE_OTTL_EVALUATOR_UNDEFINED_FUNCTIONS), which
// the real evaluator doesn't register, "OTTL syntax error: undefined
// function "<name>"", in its words. Its health is setHealth()'s: `up` (200) by default,
// `down` (the connection reset, as an evaluator that isn't there). The
// API's tests push other answers with nextFault, a queue: each evaluate or
// validate request takes the first fault waiting, if any; clearFaults()
// drops those not taken.

/** A fixed, public test credential: 32 bytes and more. */
export const FAKE_OTTL_EVALUATOR_SECRET = "telflo-fake-ottl-evaluator-secret-0123456789";

/** The start of a marker; the marker follows it. */
export const FAKE_OTTL_EVALUATOR_MARKER_PREFIX = "fake-ottl-evaluator: ";

export const FAKE_OTTL_EVALUATOR_MARKERS = ["invalid", "fail", "error", "busy", "unavailable"] as const;

export type FakeOttlEvaluatorMarker = (typeof FAKE_OTTL_EVALUATOR_MARKERS)[number];

/**
 * The transform processor's own functions, which the real evaluator's lint
 * doesn't register: a lint text calling one is "undefined function", as
 * there (D25 Task 3; TRANSFORM_CUSTOM_FUNCTIONS).
 */
export const FAKE_OTTL_EVALUATOR_UNDEFINED_FUNCTIONS: ReadonlySet<string> = new Set([
  "convert_sum_to_gauge",
  "convert_gauge_to_sum",
  "convert_summary_count_val_to_sum",
  "convert_summary_sum_val_to_sum",
  "convert_summary_quantile_val_to_gauge",
  "convert_exponential_histogram_to_histogram",
  "extract_count_metric",
  "extract_sum_metric",
  "copy_metric",
  "scale_metric",
  "aggregate_on_attributes",
  "aggregate_on_attribute_value",
]);

/** The text a rule's pattern, condition or expression holds to be answered as `marker` says. */
export function fakeOttlEvaluatorMarker(marker: FakeOttlEvaluatorMarker): string {
  return `${FAKE_OTTL_EVALUATOR_MARKER_PREFIX}${marker}`;
}

/** What GET /health answers: setHealth(). */
export type FakeOttlEvaluatorHealth = "up" | "down";

/**
 * One each, for the evaluate, validate and lint requests that follow, in
 * the order queued (GET /health is never faulted; setHealth decides it):
 * - `hang`: never answered (until close());
 * - `reset`: the connection is reset before anything is read;
 * - `error_500`: 500 `internal_error`;
 * - `evaluator_busy`: 503, with Retry-After;
 * - `invalid_request`: 400; `payload_too_large`: 413;
 * - `malformed_reply`: the answer loses a required field (a result's
 *   `passed`, validate's `valid`, a lint item's `valid`). The fake's own
 *   reply validation records it as a violation;
 * - `missing_result`, `extra_result`, `duplicate_result` (evaluate and
 *   lint): the answer drops its last result (item), adds one for an id (a
 *   kind and index) it wasn't asked for, or repeats its first: each keeps
 *   the file's shapes, so none is a violation, and the client must see that
 *   the results aren't the rules' (the items aren't the texts').
 */
export type FakeOttlEvaluatorFault =
  | "hang"
  | "reset"
  | "error_500"
  | "evaluator_busy"
  | "invalid_request"
  | "payload_too_large"
  | "malformed_reply"
  | "missing_result"
  | "extra_result"
  | "duplicate_result";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** The operations the fake answers but health. */
export type FakeOttlEvaluatorOperation = "evaluate" | "validate" | "lint";

/**
 * An evaluate, validate or lint request the fake read, once authenticated and
 * routed: its body as it came, but for an output's base64, which is kept as
 * its decoded size and SHA-256 (`{sizeBytes, sha256}`) in the base64's place.
 */
export interface FakeOttlEvaluatorRequest {
  operation: FakeOttlEvaluatorOperation;
  /** The body, or undefined when it wasn't JSON. */
  body: Json | undefined;
}

export interface FakeOttlEvaluator {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  secret: string;
  /** Queues a fault for the next evaluate, validate or lint request that has none yet. */
  nextFault(fault: FakeOttlEvaluatorFault): void;
  /** Drops every fault queued and not yet taken (useFakeOttlEvaluator does, before each test). */
  clearFaults(): void;
  /** What GET /health answers from now on. */
  setHealth(health: FakeOttlEvaluatorHealth): void;
  /** Every evaluate, validate and lint request since the last call, in order (at most the last 200); clears them. */
  takeRequests(): FakeOttlEvaluatorRequest[];
  /** Every contract violation since the last call, in order; clears them. */
  takeViolations(): string[];
  /** Closes the server and every connection; rejects if a violation is unread. */
  close(): Promise<void>;
}

export interface FakeOttlEvaluatorOptions {
  /** Default FAKE_OTTL_EVALUATOR_SECRET. */
  secret?: string;
  /** The port on 127.0.0.1. Default 0, any free one; the browser tests' fixes one (28089). */
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

const OPENAPI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../services/ottl-evaluator/openapi.yaml");

/** The $id the file's schemas are registered under; never fetched. */
const SCHEMAS_ID = "https://ottl-evaluator.telflo.invalid/openapi.yaml";

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
  /** components.schemas.ErrorEnvelope, for replies to requests no operation matches. */
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

  // The file's `oneOf`s pair `type: "null"` with a $ref, and a Problem's
  // message puts a description beside its $ref, which strictTypes would
  // refuse. Every other strict check stays.
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true, allowUnionTypes: true });
  ajv.addVocabulary(["example"]);
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
    errorReply: compile({ $ref: "#/components/schemas/ErrorEnvelope" }, "ErrorEnvelope"),
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

function isObject(node: Json | undefined): node is JsonObject {
  return node !== null && node !== undefined && typeof node === "object" && !Array.isArray(node);
}

// ---------------------------------------------------------------------------
// The answers.

/** The real evaluator's body caps: 36 MiB for evaluate, 64 KiB for validate, 10 MiB for lint. */
const MAX_BODY_BYTES: Readonly<Record<string, number>> = { evaluate: 37_748_736, validate: 65_536, lint: 10_485_760 };
/** Bodies past this aren't read at all: the fake drops the connection. */
const MAX_READ_BYTES = 40 * 1024 * 1024;
/** The output's most bytes, decoded (openapi.yaml's Output). */
const MAX_OUTPUT_BYTES = 10_485_760;
/** How many requests takeRequests() keeps, so a browser run's fake doesn't grow without bound. */
const MAX_KEPT_REQUESTS = 200;
/** The OTTL version the fake says it runs: the evaluator's. */
const FAKE_OTTL_VERSION = "v0.162.0";

/** The contexts a signal allows, as the evaluator's table has them (pkg/ottlassert's signalContexts). */
const CONTEXTS_BY_SIGNAL: Readonly<Record<string, readonly string[]>> = {
  logs: ["log", "resource", "scope"],
  traces: ["span", "spanevent", "resource", "scope"],
  metrics: ["metric", "datapoint", "resource", "scope"],
};

/** The evaluator's words for a context its signal doesn't allow (internal/rules/check.go's contextMessage). */
function contextMessage(signal: string, context: string): string {
  const names = CONTEXTS_BY_SIGNAL[signal] ?? [];
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `A ${signal} rule can't use the "${context}" context: use ${listed}.`;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Json;
}

function errorReply(status: number, code: string, message: string): Reply {
  return { status, headers: { "content-type": "application/json" }, body: { error: { code, message } } };
}

const busyReply = (): Reply => ({
  ...errorReply(503, "evaluator_busy", "The evaluator is busy. Try again shortly."),
  headers: { "content-type": "application/json", "retry-after": "1" },
});
const internalErrorReply = (): Reply => errorReply(500, "internal_error", "The evaluator couldn't answer.");

const FAULT_REPLIES: Partial<Record<FakeOttlEvaluatorFault, () => Reply>> = {
  error_500: internalErrorReply,
  evaluator_busy: busyReply,
  invalid_request: () => errorReply(400, "invalid_request", "The request doesn't follow the contract."),
  payload_too_large: () => errorReply(413, "payload_too_large", "The request body is too large."),
};

const notFound = (): Reply => errorReply(404, "not_found", "Not found.");
const unauthorized = (): Reply => ({
  ...errorReply(401, "unauthorized", "A valid secret is required."),
  headers: { "content-type": "application/json", "www-authenticate": "Bearer", connection: "close" },
});

const MARKER = /fake-ottl-evaluator: (invalid|fail|error|busy|unavailable)\b/g;

/** The texts a rule holds: its pattern, or its OTTL's condition and expression, with the field each is. */
function textsOf(rule: JsonObject): Array<{ field: string; text: string }> {
  const texts: Array<{ field: string; text: string }> = [];
  if (typeof rule.pattern === "string") texts.push({ field: "pattern", text: rule.pattern });
  const ottl = rule.ottl;
  if (isObject(ottl)) {
    if (typeof ottl.condition === "string") texts.push({ field: "ottl.condition", text: ottl.condition });
    if (typeof ottl.expression === "string") texts.push({ field: "ottl.expression", text: ottl.expression });
  }
  return texts;
}

/** The markers a rule holds, each with the first field holding it. */
function markersOf(rule: JsonObject): Map<FakeOttlEvaluatorMarker, string> {
  const markers = new Map<FakeOttlEvaluatorMarker, string>();
  for (const { field, text } of textsOf(rule)) {
    for (const match of text.matchAll(MARKER)) {
      const marker = match[1] as FakeOttlEvaluatorMarker;
      if (!markers.has(marker)) markers.set(marker, field);
    }
  }
  return markers;
}

/** The words a rule's `invalid` marker answers: a parser's or a regexp's message after the evaluator's prefix. */
function invalidMessage(rule: JsonObject): string {
  if (rule.kind === "ottl") return 'OTTL syntax error: 1:1: unexpected token "fake-ottl-evaluator" (fake)';
  if (rule.kind === "contains_regex" || rule.kind === "not_contains_regex") {
    return "Invalid regex: error parsing regexp: missing closing ): `(fake-ottl-evaluator` (fake)";
  }
  return "The pattern is empty.";
}

/** A failed rule's detail, by its kind. */
function failureDetail(rule: JsonObject, output: Buffer | null, log: string): JsonObject {
  const source = rule.target === "stderr" ? "stderr" : "output";
  if (rule.kind === "contains_text" || rule.kind === "contains_regex") {
    const searched = source === "stderr" ? [...log].length : output === null ? 0 : [...output.toString("utf8")].length;
    return { kind: "no_match", source, searchedCharacters: searched };
  }
  if (rule.kind === "not_contains_text" || rule.kind === "not_contains_regex") {
    return {
      kind: "unexpected_match",
      source,
      totalMatchCount: 1,
      moreMatches: false,
      matches: [
        {
          text: "fake-ottl-evaluator",
          textTruncated: false,
          before: "",
          after: "",
          record: source === "stderr" ? { line: 1 } : { index: 0, path: "" },
        },
      ],
    };
  }
  const ottl = isObject(rule.ottl) ? rule.ottl : {};
  if (ottl.quantifier === "distinct") {
    return { kind: "distinct_mismatch", totalCount: 1, matchedCount: 1, distinctCount: 1, samples: ["fake-ottl-evaluator"] };
  }
  // As the evaluator lists misses (openapi.yaml's RecordMismatch): all and
  // any the records that evaluated to false, none those that matched, count
  // none at all.
  const context = typeof ottl.context === "string" ? ottl.context : "log";
  if (ottl.quantifier === "count") {
    return { kind: "record_mismatch", context, totalCount: 1, matchedCount: 0, missCount: 0, misses: [] };
  }
  if (ottl.quantifier === "none") {
    return {
      kind: "record_mismatch",
      context,
      totalCount: 1,
      matchedCount: 1,
      missCount: 1,
      misses: [{ index: 0, reason: "unexpected match", snippet: "{}" }],
    };
  }
  return {
    kind: "record_mismatch",
    context,
    totalCount: 1,
    matchedCount: 0,
    missCount: 1,
    misses: [{ index: 0, reason: "condition evaluated to false", snippet: "{}" }],
  };
}

/** The answer the fake gives an evaluate request the contract takes (the module's comment says how). */
function answerEvaluate(body: JsonObject, output: Buffer | null): Reply {
  const rules = (body.rules as Json[]).filter(isObject);
  const all = rules.map(markersOf);
  if (all.some((markers) => markers.has("busy"))) return busyReply();
  if (all.some((markers) => markers.has("unavailable"))) return internalErrorReply();
  const log = typeof body.log === "string" ? body.log : "";
  const truncated = isObject(body.output) && body.output.truncated === true;
  const results = rules.map((rule, index): JsonObject => {
    const markers = all[index]!;
    const result = { id: rule.id as string, passed: true, error: null, advisory: null, detail: null } as JsonObject;
    if (markers.has("invalid")) return { ...result, passed: false, error: invalidMessage(rule) };
    if (markers.has("error")) return { ...result, passed: false, error: "Not checked: the rules took longer than 20 s to check." };
    const advisory = truncated && rule.target === "output" ? "Only the first 10 MiB of the output was checked (R-006)." : null;
    if (markers.has("fail")) return { ...result, passed: false, advisory, detail: failureDetail(rule, output, log) };
    return { ...result, advisory };
  });
  return { status: 200, headers: { "content-type": "application/json" }, body: { ottlVersion: FAKE_OTTL_VERSION, results } };
}

/** The answer the fake gives a validate request the contract takes. */
function answerValidate(body: JsonObject): Reply {
  const rule = isObject(body.rule) ? body.rule : {};
  const markers = markersOf(rule);
  if (markers.has("busy")) return busyReply();
  if (markers.has("unavailable")) return internalErrorReply();
  const problems: JsonObject[] = [];
  const ottl = isObject(rule.ottl) ? rule.ottl : undefined;
  const signal = typeof body.signal === "string" ? body.signal : "";
  if (ottl !== undefined && typeof ottl.context === "string" && !(CONTEXTS_BY_SIGNAL[signal] ?? []).includes(ottl.context)) {
    problems.push({ field: "ottl.context", message: contextMessage(signal, ottl.context) });
  }
  const invalidField = markers.get("invalid");
  if (invalidField !== undefined) problems.push({ field: invalidField, message: invalidMessage(rule) });
  const answer: JsonObject =
    problems.length === 0 ? { valid: true, ottlVersion: FAKE_OTTL_VERSION } : { valid: false, problems, ottlVersion: FAKE_OTTL_VERSION };
  return { status: 200, headers: { "content-type": "application/json" }, body: answer };
}

/** A lint text's first call, when it is one: `name(`. */
const CALL = /^\s*([A-Za-z_][A-Za-z0-9_]*)\(/;

/** The answer the fake gives a lint request the contract takes: each text by its markers, in the evaluator's order. */
function answerLint(body: JsonObject): Reply {
  const lists: Array<[string, string]> = [
    ["conditions", "condition"],
    ["statements", "statement"],
    ["valueExpressions", "valueExpression"],
  ];
  const texts = lists.flatMap(([member, kind]) =>
    (Array.isArray(body[member]) ? (body[member] as Json[]) : []).map((text, index) => ({ kind, index, text: String(text) })),
  );
  const markers = texts.map(({ text }) => new Set([...text.matchAll(MARKER)].map((match) => match[1] as FakeOttlEvaluatorMarker)));
  if (markers.some((each) => each.has("busy"))) return busyReply();
  if (markers.some((each) => each.has("unavailable"))) return internalErrorReply();
  const items = texts.map(({ kind, index, text }, at): JsonObject => {
    if (markers[at]!.has("invalid")) {
      return { kind, index, valid: false, error: 'OTTL syntax error: 1:1: unexpected token "fake-ottl-evaluator" (fake)' };
    }
    const called = CALL.exec(text)?.[1];
    if (called !== undefined && FAKE_OTTL_EVALUATOR_UNDEFINED_FUNCTIONS.has(called)) {
      return { kind, index, valid: false, error: `OTTL syntax error: undefined function "${called}"` };
    }
    return { kind, index, valid: true };
  });
  return { status: 200, headers: { "content-type": "application/json" }, body: { ottlVersion: FAKE_OTTL_VERSION, items } };
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
export async function startFakeOttlEvaluator(options: FakeOttlEvaluatorOptions = {}): Promise<FakeOttlEvaluator> {
  const { operations, errorReply: errorEnvelope, unauthorized: unauthorizedResponse } = theContract();
  const secret = options.secret ?? FAKE_OTTL_EVALUATOR_SECRET;
  const violations: string[] = [];
  const requests: FakeOttlEvaluatorRequest[] = [];
  const faults: FakeOttlEvaluatorFault[] = [];
  let health: FakeOttlEvaluatorHealth = "up";

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
   * The request's violations of the operation's contract, recorded, and the
   * real evaluator's answer when it refuses it (the body's size, JSON,
   * fields, the output's base64 and size), else the body it reads.
   */
  function readRequest(
    operation: ContractOperation,
    request: IncomingMessage,
    body: Buffer,
  ): { reply: Reply; parsed: Json | undefined } | { body: JsonObject; output: Buffer | null; parsed: Json } {
    const where = `${operation.operationId} request`;
    const cap = MAX_BODY_BYTES[operation.operationId] ?? MAX_BODY_BYTES.validate!;
    if (body.length > cap) {
      violation(`${where}: the body is larger than ${cap} bytes`);
      return { reply: errorReply(413, "payload_too_large", "The request body is too large."), parsed: undefined };
    }
    const contentType = singleHeader(request.headers, "content-type");
    if (operation.requestBody === undefined || mediaTypeOf(contentType) !== operation.requestBody.mediaType) {
      violation(`${where}: Content-Type isn't application/json`);
      return { reply: errorReply(400, "invalid_request", "The request body must be JSON."), parsed: undefined };
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Json;
    } catch {
      violation(`${where}: the body isn't JSON`);
      return { reply: errorReply(400, "invalid_request", "The request body must be JSON."), parsed: undefined };
    }
    let isValid = operation.requestBody.validate(parsed);
    if (!isValid) violation(`${where} body: ${describeErrors(operation.requestBody.validate.errors)}`);
    let output: Buffer | null = null;
    if (isObject(parsed) && isObject(parsed.output) && typeof parsed.output.base64 === "string") {
      const decoded = decodeBase64(parsed.output.base64);
      if (decoded === undefined) {
        violation(`${where} body: /output/base64 isn't standard base64`);
        isValid = false;
      } else if (decoded.byteLength > MAX_OUTPUT_BYTES) {
        violation(`${where} body: /output/base64 is larger than 10 MiB decoded`);
        isValid = false;
      } else {
        output = decoded;
      }
    }
    if (isValid && isObject(parsed) && Array.isArray(parsed.rules)) {
      const ids = parsed.rules.filter(isObject).map((rule) => rule.id);
      if (new Set(ids).size !== ids.length) {
        violation(`${where} body: /rules repeats an id`);
        isValid = false;
      }
    }
    if (!isValid) return { reply: errorReply(400, "invalid_request", "The request doesn't follow the contract."), parsed };
    return { body: parsed as JsonObject, output, parsed };
  }

  function send(response: ServerResponse, reply: Reply): void {
    response.writeHead(reply.status, reply.headers);
    response.end(JSON.stringify(reply.body));
  }

  function keep(operation: FakeOttlEvaluatorOperation, parsed: Json | undefined): void {
    let body = parsed;
    if (isObject(parsed) && isObject(parsed.output) && typeof parsed.output.base64 === "string") {
      const bytes = Buffer.from(parsed.output.base64, "base64");
      body = {
        ...parsed,
        output: {
          ...parsed.output,
          base64: { sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
        },
      };
    }
    requests.push({ operation, body });
    if (requests.length > MAX_KEPT_REQUESTS) requests.shift();
  }

  /** The fault's change to a 200 answer, if it makes one. */
  function faulted(fault: FakeOttlEvaluatorFault | undefined, reply: Reply, operation: FakeOttlEvaluatorOperation): Reply {
    if (reply.status !== 200 || fault === undefined || !isObject(reply.body)) return reply;
    const answer = reply.body;
    if (operation === "lint") {
      const items = answer.items as JsonObject[];
      const [first, ...others] = items;
      if (first === undefined) return reply;
      if (fault === "malformed_reply") {
        const { valid: _dropped, ...rest } = first;
        return { ...reply, body: { ...answer, items: [rest, ...others] } };
      }
      if (fault === "missing_result") return { ...reply, body: { ...answer, items: items.slice(0, -1) } };
      if (fault === "extra_result") return { ...reply, body: { ...answer, items: [...items, { kind: "statement", index: 199, valid: true }] } };
      if (fault === "duplicate_result") return { ...reply, body: { ...answer, items: [first, ...items.slice(1, -1), first] } };
      return reply;
    }
    if (fault === "malformed_reply") {
      if (operation === "validate") {
        const { valid: _dropped, ...rest } = answer;
        return { ...reply, body: rest };
      }
      const results = answer.results as JsonObject[];
      const [first, ...others] = results;
      if (first === undefined) return reply;
      const { passed: _dropped, ...rest } = first;
      return { ...reply, body: { ...answer, results: [rest, ...others] } };
    }
    if (operation !== "evaluate") return reply;
    const results = answer.results as JsonObject[];
    if (fault === "missing_result") return { ...reply, body: { ...answer, results: results.slice(0, -1) } };
    if (fault === "extra_result") {
      const extra = { id: "not-a-rule-it-was-asked-for", passed: true, error: null, advisory: null, detail: null };
      return { ...reply, body: { ...answer, results: [...results, extra] } };
    }
    if (fault === "duplicate_result" && results[0] !== undefined) {
      return { ...reply, body: { ...answer, results: [results[0], ...results.slice(1, -1), results[0]] } };
    }
    return reply;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-ottl-evaluator.invalid");
    const method = request.method ?? "GET";
    const operation = operations.find((candidate) => candidate.path === url.pathname && candidate.method === method);

    if (operation !== undefined && !operation.isSecured) {
      // GET /health: no secret, never faulted.
      if (health === "down") {
        request.socket.resetAndDestroy();
        return;
      }
      const body = await readBody(request);
      if (body !== undefined && body.length > 0) violation(`${operation.operationId} request: has a body, which it doesn't take`);
      if (url.search !== "") violation(`${operation.operationId} request: has a query, which it doesn't take`);
      const reply: Reply = { status: 200, headers: { "content-type": "application/json" }, body: { status: "ok", ottlVersion: FAKE_OTTL_VERSION } };
      checkReply(operation, reply);
      send(response, reply);
      return;
    }

    if (operation !== undefined && faults[0] === "reset") {
      faults.shift();
      request.socket.resetAndDestroy();
      return;
    }

    // The secret is checked before routing and before the body, as the real
    // evaluator's is. A request without the Bearer scheme breaks the security
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
    const kind: FakeOttlEvaluatorOperation =
      operation.operationId === "evaluate" ? "evaluate" : operation.operationId === "lint" ? "lint" : "validate";
    const read = readRequest(operation, request, body);
    keep(kind, read.parsed);

    const fault = faults.shift();
    if (fault === "hang") return;

    const faultReply = fault === undefined ? undefined : FAULT_REPLIES[fault];
    let reply: Reply;
    if (faultReply !== undefined) reply = faultReply();
    else if ("reply" in read) reply = read.reply;
    else {
      const answered =
        kind === "evaluate" ? answerEvaluate(read.body, read.output) : kind === "lint" ? answerLint(read.body) : answerValidate(read.body);
      reply = faulted(fault, answered, kind);
    }
    checkReply(operation, reply);
    send(response, reply);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      violation(`the fake failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) send(response, internalErrorReply());
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
    clearFaults() {
      faults.splice(0);
    },
    setHealth(next) {
      health = next;
    },
    takeRequests() {
      return requests.splice(0);
    },
    takeViolations() {
      return violations.splice(0);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
      if (violations.length > 0) {
        throw new Error(`The fake ottl-evaluator saw contract violations no test read:\n${violations.join("\n")}`);
      }
    },
  };
}
