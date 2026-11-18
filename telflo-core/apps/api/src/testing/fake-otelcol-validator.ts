import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml, parseDocument } from "yaml";

// The collector validator in memory, for tests only (D13b Preflight ruling
// 20). Built on node:http, as the fake opamp-server is. It never ships:
// .dockerignore leaves apps/api/src/testing out of the images, and a lint
// rule keeps production code from importing it.
//
// It checks the contract both ways: every request it receives and every
// reply it sends is validated against services/otelcol-validator/openapi.yaml,
// with ajv's JSON Schema 2020-12 dialect. A mismatch is a violation: kept
// until takeViolations() reads it, and close() rejects while any is unread,
// so a test that forgets to look still fails. The request is then answered
// as the real validator would (a 400, 401, 404 or 413), so the client under
// test sees a realistic reply.
//
// It runs no collector. It answers by the TEXT, so the browser tests, which
// run in parallel and share one fake, each get the answer their own text
// asks for:
//
// - valid, by default;
// - invalid, with one error per component whose type starts with `unknown_`
//   (`exporters::unknown_thing/2`), or one error when the text isn't YAML;
// - one `env_var` requirement per `${env:NAME}`, valid or not;
// - one "Organization variables filled in" requirement naming the
//   `organizationVariables` the request sent, as the real validator names
//   those it filled in (D20 decision 27). That row only: it fills nothing
//   in itself, so it never answers the real one's "Unresolved organization
//   variable", over-128-characters or legacy rows, nor its 1 MiB
//   `filled_in_too_long` refusal;
// - 503 `validator_busy` when the text holds `# fake-otelcol-validator: unavailable`.
//
// It knows no catalogue: any distribution and version in the path's format
// is checked. The API's tests push the catalogue's answers (404, 409, 503)
// with nextFault.

/** A fixed, public test credential: 32 bytes and more. */
export const FAKE_OTELCOL_VALIDATOR_SECRET = "telflo-fake-otelcol-validator-secret-0123456789";

/** A line a text holds to be answered 503 `validator_busy` (Preflight ruling 20). */
export const FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER = "# fake-otelcol-validator: unavailable";

/** A component type the fake refuses as unknown starts with this. */
export const FAKE_OTELCOL_VALIDATOR_UNKNOWN_TYPE_PREFIX = "unknown_";

/**
 * One shot each, for the next validation request (GET /health is never
 * faulted):
 * - `hang`: never answered (until close());
 * - `reset`: the connection is reset before anything is read;
 * - `error_500`: 500 `internal_error`;
 * - `not_found`: 404, as for a distribution or version its catalogue doesn't list;
 * - `version_retired`: 409, as for a version its catalogue deprecated;
 * - `version_unavailable`: 503, as for an offered version it doesn't hold;
 * - `validator_busy`: 503, as when no slot freed up;
 * - `invalid_request`: 400;
 * - `payload_too_large`: 413;
 * - `malformed_reply`: the answer loses its `valid` field. The fake's own
 *   reply validation records it as a violation.
 */
export type FakeOtelcolValidatorFault =
  | "hang"
  | "reset"
  | "error_500"
  | "not_found"
  | "version_retired"
  | "version_unavailable"
  | "validator_busy"
  | "invalid_request"
  | "payload_too_large"
  | "malformed_reply";

/** A validation request the fake read, once authenticated and routed. */
export interface FakeOtelcolValidatorRequest {
  distribution: string;
  version: string;
  /** The body's `yaml`, or undefined when the body had none. */
  yaml: string | undefined;
  /** The body's `organizationVariables`, or undefined when it sent none (D20). */
  organizationVariables?: Record<string, string> | undefined;
}

export interface FakeOtelcolValidator {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  secret: string;
  nextFault(fault: FakeOtelcolValidatorFault): void;
  /** Every validation request since the last call, in order (at most the last 1,000); clears them. */
  takeRequests(): FakeOtelcolValidatorRequest[];
  /** Every contract violation since the last call, in order; clears them. */
  takeViolations(): string[];
  /** Closes the server and every connection; rejects if a violation is unread. */
  close(): Promise<void>;
}

export interface FakeOtelcolValidatorOptions {
  /** Default FAKE_OTELCOL_VALIDATOR_SECRET. */
  secret?: string;
  /** The port on 127.0.0.1. Default 0, any free one; the browser tests' fixes one (28086). */
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

const OPENAPI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../services/otelcol-validator/openapi.yaml");

/** The $id the file's schemas are registered under; never fetched. */
const SCHEMAS_ID = "https://otelcol-validator.telflo.invalid/openapi.yaml";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ContractResponse {
  headers: { name: string; required: boolean; validate: ValidateFunction }[];
  content: { mediaType: string; validate: ValidateFunction } | undefined;
}

interface ContractOperation {
  operationId: string;
  method: string;
  pattern: RegExp;
  pathParameterNames: string[];
  pathParameters: Map<string, ValidateFunction>;
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

/** Follows a `$ref` to components.parameters or components.responses; anything else as it is. */
function dereference(document: JsonObject, node: Json | undefined, where: string): JsonObject {
  const object = asObject(node, where);
  const ref = object.$ref;
  if (typeof ref !== "string") return object;
  const match = /^#\/components\/(parameters|responses)\/([^/]+)$/.exec(ref);
  if (match === null) throw new Error(`openapi.yaml: unsupported $ref ${ref} at ${where}`);
  const components = asObject(document.components, "components");
  return asObject(asObject(components[match[1] as string], match[1] as string)[match[2] as string], ref);
}

function loadContract(): Contract {
  const document = asObject(parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as Json, "the document");
  const components = asObject(document.components, "components");

  // The file's if/then/else names `properties` without `type: object`
  // beside it, which strictTypes would refuse; every other strict check stays.
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
  for (const [template, rawPathItem] of Object.entries(asObject(document.paths, "paths"))) {
    const pathItem = asObject(rawPathItem, template);
    const pathParameterNames: string[] = [];
    const pattern = new RegExp(
      `^${template.replace(/\{([^}]+)\}/g, (_whole, name: string) => {
        pathParameterNames.push(name);
        return "([^/]+)";
      })}$`,
    );
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of ["get", "put", "delete", "post", "patch", "head", "options"]) {
      if (pathItem[method] === undefined) continue;
      const operation = asObject(pathItem[method], `${template} ${method}`);
      const operationId = String(operation.operationId);
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      const pathParameters = new Map<string, ValidateFunction>();
      [...shared, ...own].forEach((raw, index) => {
        const parameter = dereference(document, raw, `${operationId} parameter ${index}`);
        if (parameter.in !== "path") throw new Error(`openapi.yaml: the fake reads path parameters only (${operationId})`);
        pathParameters.set(String(parameter.name), compile(parameter.schema, `${operationId} ${String(parameter.name)}`));
      });

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
        pattern,
        pathParameterNames,
        pathParameters,
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

// ---------------------------------------------------------------------------
// The answers.

/** The real validator's body cap (D20 Preflight ruling 30, re-derived on Q104): 2 MiB. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Bodies past this aren't read at all: the fake drops the connection. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** The real validator's limit on `yaml` (Ruling 27): the platform's. */
const MAX_YAML_CHARACTERS = 262_144;
/** How many requests takeRequests() keeps, so a browser run's fake doesn't grow without bound. */
const MAX_KEPT_REQUESTS = 1_000;

const SECTIONS = ["receivers", "processors", "exporters", "connectors", "extensions"] as const;

/** `${env:NAME}` and `${env:NAME:-default}`, as the real validator reads them. */
const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Json;
}

function errorReply(status: number, code: string, message: string): Reply {
  return { status, headers: { "content-type": "application/json" }, body: { error: { code, message } } };
}

const FAULT_REPLIES: Partial<Record<FakeOtelcolValidatorFault, () => Reply>> = {
  error_500: () => errorReply(500, "internal_error", "Internal server error."),
  not_found: () => errorReply(404, "not_found", "The catalogue lists no such version of this distribution."),
  version_retired: () =>
    errorReply(409, "version_retired", "This collector version is retired: pick an offered version to check this configuration."),
  version_unavailable: () =>
    errorReply(503, "version_unavailable", "This validator doesn't hold that collector version."),
  validator_busy: () => errorReply(503, "validator_busy", "Every validation slot is busy. Retry shortly."),
  invalid_request: () => errorReply(400, "invalid_request", "The request body must be a JSON object."),
  payload_too_large: () => errorReply(413, "payload_too_large", "The request body is larger than 2 MiB."),
};

const notFound = (): Reply => errorReply(404, "not_found", "Not found.");
const unauthorized = (): Reply => ({
  ...errorReply(401, "unauthorized", "Missing or invalid credentials."),
  headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
});
const busy = (): Reply => errorReply(503, "validator_busy", "Every validation slot is busy. Retry shortly.");

/** The answer the fake gives `yaml` (the module's comment says how). */
function answerText(
  yaml: string,
  distribution: string,
  version: string,
  organizationVariables: Record<string, string> | undefined,
): Reply {
  if (yaml.includes(FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER)) return busy();

  const errors: JsonObject[] = [];
  let parsed: unknown;
  try {
    const document = parseDocument(yaml);
    parsed = document.errors.length > 0 ? undefined : document.toJS();
    if (document.errors.length > 0) {
      errors.push({ message: "The configuration can't be read as YAML.", componentPath: null });
    }
  } catch {
    errors.push({ message: "The configuration can't be read as YAML.", componentPath: null });
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const section of SECTIONS) {
      const components = (parsed as Record<string, unknown>)[section];
      if (components === null || typeof components !== "object" || Array.isArray(components)) continue;
      for (const id of Object.keys(components)) {
        const type = id.split("/")[0] ?? id;
        if (type.startsWith(FAKE_OTELCOL_VALIDATOR_UNKNOWN_TYPE_PREFIX)) {
          errors.push({ message: `unknown type: "${type}" for id: "${id}"`, componentPath: `${section}::${id}` });
        }
      }
    }
  }

  const requirements: JsonObject[] = [];
  const filledIn = Object.keys(organizationVariables ?? {});
  if (filledIn.length > 0) {
    const description = `Validation filled in your organization's values of these variables before its checks: ${filledIn.join(", ")}.`;
    requirements.push({
      category: "organization_variable",
      title: "Organization variables filled in",
      // Cut as the real validator cuts it: 4,096 bytes, "…" (3 of them) included; names are ASCII.
      description: description.length > 4096 ? `${description.slice(0, 4093)}…` : description,
      componentPath: null,
    });
  }
  const names = [...new Set([...yaml.matchAll(ENV_REFERENCE)].map((match) => match[1] as string))];
  requirements.push(...names.map((name) => ({
    category: "env_var",
    title: `Set environment variable ${name}`,
    description: `This configuration references ${name} via \${env:${name}}. Set it in your deployment environment before starting the collector, or provide a default with \${env:${name}:-fallback}.`,
    componentPath: null,
  })));

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { valid: errors.length === 0, errors, requirements, distribution, version },
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
export async function startFakeOtelcolValidator(options: FakeOtelcolValidatorOptions = {}): Promise<FakeOtelcolValidator> {
  const { operations, errorReply: errorEnvelope, unauthorized: unauthorizedResponse } = theContract();
  const secret = options.secret ?? FAKE_OTELCOL_VALIDATOR_SECRET;
  const violations: string[] = [];
  const requests: FakeOtelcolValidatorRequest[] = [];
  let pendingFault: FakeOtelcolValidatorFault | undefined;

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
   * The request's violations of `operation`'s contract, recorded, and the
   * real validator's answer when it refuses it (the path first, before the
   * body is read; then the body's size, JSON and fields), else its body.
   */
  function readRequest(
    operation: ContractOperation,
    request: IncomingMessage,
    pathValues: Map<string, string>,
    body: Buffer,
  ): Reply | { yaml: string; organizationVariables: Record<string, string> | undefined } {
    const where = `${operation.operationId} request`;
    let badPath = false;
    for (const [name, validate] of operation.pathParameters) {
      if (!validate(pathValues.get(name))) {
        violation(`${where}: path parameter ${name} ${describeErrors(validate.errors)}`);
        badPath = true;
      }
    }
    if (badPath) return errorReply(400, "invalid_request", "The path isn't a distribution and a version.");
    if (body.length > MAX_BODY_BYTES) {
      violation(`${where}: the body is larger than 2 MiB`);
      return errorReply(413, "payload_too_large", "The request body is larger than 2 MiB.");
    }
    const contentType = singleHeader(request.headers, "content-type");
    if (operation.requestBody === undefined || mediaTypeOf(contentType) !== operation.requestBody.mediaType) {
      violation(`${where}: Content-Type isn't application/json`);
      return errorReply(400, "invalid_request", "Content-Type must be application/json.");
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Json;
    } catch {
      violation(`${where}: the body isn't JSON`);
      return errorReply(400, "invalid_request", "The request body must be a JSON object.");
    }
    if (!operation.requestBody.validate(parsed)) {
      violation(`${where} body: ${describeErrors(operation.requestBody.validate.errors)}`);
      const yaml = (parsed as { yaml?: unknown } | null)?.yaml;
      if (typeof yaml === "string" && [...yaml].length > MAX_YAML_CHARACTERS) {
        return errorReply(413, "payload_too_large", "The yaml is longer than 262,144 characters.");
      }
      return errorReply(400, "invalid_request", "The request body doesn't match the API.");
    }
    const { yaml, organizationVariables } = parsed as { yaml: string; organizationVariables?: Record<string, string> };
    return { yaml, organizationVariables };
  }

  function send(response: ServerResponse, reply: Reply): void {
    response.writeHead(reply.status, reply.headers);
    response.end(JSON.stringify(reply.body));
  }

  function keep(entry: FakeOtelcolValidatorRequest): void {
    requests.push(entry);
    if (requests.length > MAX_KEPT_REQUESTS) requests.shift();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-otelcol-validator.invalid");
    const method = request.method ?? "GET";
    let operation: ContractOperation | undefined;
    const pathValues = new Map<string, string>();
    for (const candidate of operations) {
      const match = candidate.pattern.exec(url.pathname);
      if (match === null || candidate.method !== method) continue;
      operation = candidate;
      candidate.pathParameterNames.forEach((name, index) => {
        pathValues.set(name, decodeURIComponent(match[index + 1] as string));
      });
      break;
    }

    if (operation !== undefined && !operation.isSecured) {
      // GET /health: no secret, never faulted.
      const body = await readBody(request);
      if (body !== undefined && body.length > 0) violation(`${operation.operationId} request: has a body, which it doesn't take`);
      if (url.search !== "") violation(`${operation.operationId} request: has a query, which it doesn't take`);
      const reply: Reply = { status: 200, headers: { "content-type": "application/json" }, body: { status: "ok" } };
      checkReply(operation, reply);
      send(response, reply);
      return;
    }

    if (pendingFault === "reset") {
      pendingFault = undefined;
      request.socket.resetAndDestroy();
      return;
    }

    // Authentication comes before routing and before the body, as the real
    // validator's does. A request without the Bearer scheme breaks the
    // security scheme; a wrong secret is a documented 401.
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
    const read = readRequest(operation, request, pathValues, body);
    const distribution = pathValues.get("distribution") ?? "";
    const version = pathValues.get("version") ?? "";
    keep({
      distribution,
      version,
      yaml: "yaml" in read ? read.yaml : undefined,
      organizationVariables: "yaml" in read ? read.organizationVariables : undefined,
    });

    const fault = pendingFault;
    pendingFault = undefined;
    if (fault === "hang") return;

    let reply: Reply;
    const faultReply = fault === undefined ? undefined : FAULT_REPLIES[fault];
    if (faultReply !== undefined) {
      reply = faultReply();
    } else if (!("yaml" in read)) {
      reply = read;
    } else {
      reply = answerText(read.yaml, distribution, version, read.organizationVariables);
      if (fault === "malformed_reply" && reply.status === 200) {
        const { valid: _dropped, ...rest } = reply.body as JsonObject;
        reply = { ...reply, body: rest };
      }
    }
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
      pendingFault = fault;
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
        throw new Error(`The fake otelcol-validator saw contract violations no test read:\n${violations.join("\n")}`);
      }
    },
  };
}
