import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import {
  AFTER_LATEST_INSTANT,
  createFleetModel,
  DATE_TIME_PATTERN,
  EARLIEST_INSTANT,
  errorReply,
  formatMilliseconds,
  invalidRequest,
  isReply,
  jsonReply as json,
  noContent,
  organizationNotFound,
  toMilliseconds,
  type CollectorErrorReport,
  type CollectorStateChanges,
  type EnrollCollectorOptions,
  type EnrolledCollector,
  type Json,
  type JsonObject,
  type Reply,
  type TokenEventSeeding,
} from "./fake-opamp-server-fleets.js";
import { createVariablesModel, MAX_VARIABLE_NAME_LENGTH, variableReferences } from "./fake-opamp-server-variables.js";

// The opamp-server's management API in memory, for tests only. Built on
// node:http. It never ships: .dockerignore leaves apps/api/src/testing out of
// the images, and a lint rule keeps production code from importing it.
//
// It answers the four organization operations and the five publication
// operations with the real server's semantics (publishedAt in whole
// milliseconds): the registry, every publication and fleet route under an
// unregistered organization a 404 organization_not_found once its path ids are
// read (before its query or body), and an organization's delete taking its
// publications and its fleets with it. The 25 fleet-model operations (fleets,
// collector groups, enrollment tokens, collectors, limits and a
// configuration's usage) are fake-opamp-server-fleets.ts's, ported from the
// Go. The 11 organization variables operations are
// fake-opamp-server-variables.ts's: a publication keeps the names its live
// `${org:NAME}` references name (refusing one over 128 characters), which the
// guards, the undefined check and drift read. It checks the contract both
// ways: every request it receives and every reply it sends is validated
// against vendor/opamp-server/openapi.yaml, with ajv's JSON Schema 2020-12
// dialect. A mismatch is a violation: kept until takeViolations() reads it,
// and close() rejects while any is unread, so a test that forgets to look
// still fails. The request is then answered as the real server would (a 400,
// 401 or 404), so the client under test sees a realistic reply.
//
// Faults, one shot each (nextFault): answer 500, hang until the client gives
// up (past any timeout), reset the connection, or send a reply that breaks the
// contract; for the next request of any operation, or of one named.
//
// A published version a collector group is assigned, or a collector pinned
// to, is in use: its delete, and its configuration's, answer 409
// publication_in_use, deleting nothing, and the configuration's usage says
// so. markPublicationInUse stands for such a use without a fleet: one
// phantom pinned collector.

/** A fixed, public test credential: 32 bytes and more. */
export const FAKE_OPAMP_SERVER_SECRET = "telflo-fake-opamp-management-secret-0123456789";

/**
 * - `error_500`: the next API request answers 500 `internal_error`;
 * - `hang`: the next API request is never answered (until close());
 * - `reset`: the next request's connection is reset before anything is read;
 * - `malformed_reply`: the next API reply breaks the contract: a JSON reply
 *   loses its first field, and a 204 becomes a 200 with `{}`. The fake's own
 *   reply validation records it as a violation.
 */
export type FakeOpampServerFault = "error_500" | "hang" | "reset" | "malformed_reply";

export interface FakeOpampServer {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  secret: string;
  /**
   * Faults the next API request, or, with `operationId` (the contract's),
   * the next request for that operation; one shot. A fault for the
   * operation is taken before one for any.
   */
  nextFault(fault: FakeOpampServerFault, operationId?: string): void;
  /**
   * Marks the organization's publication as used by a collector group or a
   * collector, as the real server's fleet model would: deleting it, or its
   * configuration's, then answers 409 `publication_in_use` and deletes
   * nothing. Throws if the organization holds no such publication. `inUse`
   * false clears the mark.
   */
  markPublicationInUse(organizationId: string, publicationId: string, inUse?: boolean): void;
  /**
   * Enrolls a collector in the organization's fleet, as its first poll
   * would: in the Default group (or `groupId`), on the fleet's valid default
   * token (all revoked: its newest; or `tokenId`), seen now (or `lastSeenAt`). Throws for a fleet, group or
   * token the organization doesn't hold, a revoked or expired token or an
   * archived fleet (as the agent side's authentication refuses them), a
   * taken name, or a full cap. Its reported fields are bounded as
   * setCollectorState's.
   */
  enrollCollector(organizationId: string, fleetId: string, options?: EnrollCollectorOptions): EnrolledCollector;
  /**
   * Sets what the organization's collector was served, reports running,
   * reports of itself, or when it was seen, bounded as the agent side
   * writes them: an effective error kept only with `failed`, as
   * BoundMessage keeps it (NUL and invalid UTF-8 replaced, 8 KiB), and a
   * failure without a message given report.go's own text; a reported
   * version or address trimmed of Go's spaces, and out of bounds left as
   * stored; attributes
   * as boundedAttributes keeps them (16 KiB as jsonb writes them).
   */
  setCollectorState(organizationId: string, collectorId: string, changes: CollectorStateChanges): void;
  /**
   * Records a failure the collector reported, keeping its newest 100; its
   * message bounded as BoundMessage bounds it, and refused (a throw) when
   * nothing is left.
   */
  recordCollectorError(organizationId: string, collectorId: string, report: CollectorErrorReport): { id: string };
  /**
   * Seeds the fleet's token history with `count` events (1 to 500) of one
   * kind (default `viewed`) on one of its tokens (default its valid default
   * token, all revoked: its newest), by `actor` (default null), the newest at `occurredAt` (default
   * now), each next one a millisecond earlier: the history's paging. Throws for
   * a fleet or token the organization doesn't hold, or a count out of range.
   */
  recordTokenEvents(organizationId: string, fleetId: string, seeding: TokenEventSeeding): { count: number };
  /**
   * A deep copy of everything the fake holds for the organization (its
   * registration, publications, marks, fleets and all they hold, limits,
   * variables, variable groups and overrides, its variables counter),
   * each list sorted by id: equal before and after a request that changed
   * nothing.
   */
  snapshotOf(organizationId: string): Record<string, unknown>;
  /** Every contract violation since the last call, in order; clears them. */
  takeViolations(): string[];
  /** Closes the server and every connection; rejects if a violation is unread. */
  close(): Promise<void>;
}

export interface FakeOpampServerOptions {
  /** Default FAKE_OPAMP_SERVER_SECRET. */
  secret?: string;
  /** The server's clock: `receivedAt`, the fleet model's times, liveness and drift. Default `() => new Date()`. */
  now?: () => Date;
  /** The port on 127.0.0.1. Default 0, any free one; the browser tests' fixes one (28085). */
  port?: number;
  /**
   * Told each violation as it is recorded, which is still kept for
   * takeViolations() and close(). The browser tests' entry writes them to
   * stderr and to a file their teardown reads (e2e/start-fake-opamp-server.ts).
   */
  onViolation?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// The contract: openapi.yaml, read once and compiled with ajv.

const OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../vendor/opamp-server/openapi.yaml",
);

/** The $id the file's schemas are registered under; never fetched. */
const SCHEMAS_ID = "https://opamp-server.telflo.invalid/openapi.yaml";

interface Check {
  validate: ValidateFunction;
}

interface ContractParameter extends Check {
  name: string;
  in: "path" | "query";
  required: boolean;
  isInteger: boolean;
}

interface ContractResponse {
  headers: { name: string; required: boolean; validate: ValidateFunction }[];
  /** The media type and its schema, or undefined for a reply without a body. */
  content: { mediaType: string; validate: ValidateFunction } | undefined;
}

interface ContractOperation {
  operationId: string;
  method: string;
  pattern: RegExp;
  pathParameterNames: string[];
  parameters: ContractParameter[];
  requestBody: { mediaType: string; validate: ValidateFunction } | undefined;
  responses: Map<string, ContractResponse>;
  isSecured: boolean;
}

interface Contract {
  operations: ContractOperation[];
  /** components.schemas.Error, for replies to requests no operation matches. */
  errorReply: ValidateFunction;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** RFC 3339's date-time (JSON Schema's `date-time` format), checked by hand. */
function isDateTime(value: string): boolean {
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // setUTCFullYear, not Date.UTC, which reads the years 0 to 99 as 1900 to
  // 1999 (and 1900, unlike the year 0, isn't a leap year).
  const lastOfMonth = new Date(0);
  lastOfMonth.setUTCFullYear(year, month, 0);
  const daysInMonth = lastOfMonth.getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (match[9] !== undefined && (Number(match[10]) > 23 || Number(match[11]) > 59)) return false;
  return true;
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

  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("uuid", UUID_PATTERN);
  ajv.addFormat("date-time", { type: "string", validate: isDateTime });
  // An OpenAPI annotation JSON Schema 2020-12 doesn't define.
  ajv.addVocabulary(["example"]);
  ajv.addSchema({ $id: SCHEMAS_ID, $defs: rewriteRefs(asObject(components.schemas, "components.schemas")) });
  const compile = (schema: Json | undefined, where: string) =>
    ajv.compile(asObject(rewriteRefs(asObject(schema, where)), where));

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
      const parameters = [...shared, ...own].map((raw, index): ContractParameter => {
        const parameter = dereference(document, raw, `${operationId} parameter ${index}`);
        const schema = asObject(parameter.schema, `${operationId} parameter ${String(parameter.name)}`);
        return {
          name: String(parameter.name),
          in: parameter.in === "path" ? "path" : "query",
          required: parameter.required === true,
          isInteger: schema.type === "integer",
          validate: compile(schema, `${operationId} parameter ${String(parameter.name)}`),
        };
      });

      let requestBody: ContractOperation["requestBody"];
      if (operation.requestBody !== undefined) {
        const content = asObject(asObject(operation.requestBody, "requestBody").content, `${operationId} requestBody`);
        const [mediaType, media] = Object.entries(content)[0] as [string, Json];
        requestBody = { mediaType, validate: compile(asObject(media, mediaType).schema, `${operationId} requestBody`) };
      }

      const responses = new Map<string, ContractResponse>();
      for (const [status, raw] of Object.entries(asObject(operation.responses, `${operationId} responses`))) {
        const response = dereference(document, raw, `${operationId} ${status}`);
        const headers = Object.entries(response.headers === undefined ? {} : asObject(response.headers, "headers")).map(
          ([name, header]) => ({
            name: name.toLowerCase(),
            required: asObject(header, name).required === true,
            validate: compile(asObject(header, name).schema, `${operationId} ${status} header ${name}`),
          }),
        );
        let content: ContractResponse["content"];
        if (response.content !== undefined) {
          const [mediaType, media] = Object.entries(asObject(response.content, "content"))[0] as [string, Json];
          content = { mediaType, validate: compile(asObject(media, mediaType).schema, `${operationId} ${status}`) };
        }
        responses.set(status, { headers, content });
      }

      const security = operation.security ?? globalSecurity;
      operations.push({
        operationId,
        method: method.toUpperCase(),
        pattern,
        pathParameterNames,
        parameters,
        requestBody,
        responses,
        isSecured: Array.isArray(security) && security.length > 0,
      });
    }
  }
  return { operations, errorReply: compile({ $ref: "#/components/schemas/Error" }, "Error") };
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

// ---------------------------------------------------------------------------
// The server.

/** The real server's body cap. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Bodies past this aren't read at all: the fake drops the connection. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_YAML_BYTES = 1024 * 1024;
const DEFAULT_LIST_LIMIT = 50;

interface StoredOrganization {
  id: string;
  name: string;
  /** Whole milliseconds. */
  createdAt: number;
  updatedAt: number;
}

interface StoredPublication {
  id: string;
  organizationId: string;
  configuration: { id: string; name: string };
  version: { id: string; number: number; label: string | null };
  yaml: string;
  sha256: string;
  publishedBy: { id: string; email: string } | null;
  /** Whole milliseconds, as the real server keeps it. */
  publishedAt: number;
  receivedAt: number;
  /** The collector it was published for, as sent. */
  collector: { distribution: string; version: string };
  /** The names its live `${org:NAME}` references name, written at publish. */
  names: string[];
}

const notFound = (): Reply => errorReply(404, "not_found", "Not found.");
const payloadTooLarge = (): Reply => errorReply(413, "payload_too_large", "The request body is larger than 2 MiB.");
/** management/publications.go's messageReferenceTooLong: it names the field, never the name. */
const REFERENCE_TOO_LONG = "yaml references an organization variable name over 128 characters, which no variable can have.";
const unauthorized = (): Reply => ({
  ...errorReply(401, "unauthorized", "Missing or invalid credentials."),
  headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
});

function organizationJson(stored: StoredOrganization): JsonObject {
  return {
    organizationId: stored.id,
    name: stored.name,
    createdAt: formatMilliseconds(stored.createdAt),
    updatedAt: formatMilliseconds(stored.updatedAt),
  };
}

/**
 * The registry's own operations under an organization's path, which answer
 * a plain 404 not_found; every other one there needs the organization
 * registered.
 */
const REGISTRY_OPERATIONS = new Set(["getOrganization", "renameOrganization", "deleteOrganization"]);

function publicationJson(stored: StoredPublication, withYaml: boolean): JsonObject {
  return {
    id: stored.id,
    organizationId: stored.organizationId,
    configuration: { ...stored.configuration },
    version: { ...stored.version },
    ...(withYaml ? { yaml: stored.yaml } : {}),
    sha256: stored.sha256,
    publishedBy: stored.publishedBy === null ? null : { ...stored.publishedBy },
    publishedAt: formatMilliseconds(stored.publishedAt),
    receivedAt: formatMilliseconds(stored.receivedAt),
    collector: { ...stored.collector },
  };
}

function isIdentical(a: StoredPublication, b: StoredPublication): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.configuration.id === b.configuration.id &&
    a.configuration.name === b.configuration.name &&
    a.version.id === b.version.id &&
    a.version.number === b.version.number &&
    a.version.label === b.version.label &&
    a.yaml === b.yaml &&
    a.sha256 === b.sha256 &&
    (a.publishedBy === null
      ? b.publishedBy === null
      : b.publishedBy !== null && a.publishedBy.id === b.publishedBy.id && a.publishedBy.email === b.publishedBy.email) &&
    a.publishedAt === b.publishedAt &&
    // The collector is part of the publication.
    a.collector.distribution === b.collector.distribution &&
    a.collector.version === b.collector.version
  );
}

/** The real server's cursor: unpadded base64url of the instant in µs (8 bytes) and the id (16). */
function encodeCursor(stored: StoredPublication): string {
  const raw = Buffer.alloc(24);
  raw.writeBigInt64BE(BigInt(stored.publishedAt) * 1000n, 0);
  Buffer.from(stored.id.replaceAll("-", ""), "hex").copy(raw, 8);
  return raw.toString("base64url");
}

function decodeCursor(cursor: string): { publishedAt: number; id: string } | undefined {
  const raw = Buffer.from(cursor, "base64url");
  if (raw.length !== 24 || raw.toString("base64url") !== cursor) return undefined;
  const hex = raw.subarray(8).toString("hex");
  return {
    publishedAt: Math.floor(Number(raw.readBigInt64BE(0)) / 1000),
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

/** Newest first: publishedAt, then id, both descending (ids compare as bytes, as Postgres's uuid does). */
function newestFirst(a: { publishedAt: number; id: string }, b: { publishedAt: number; id: string }): number {
  if (a.publishedAt !== b.publishedAt) return b.publishedAt - a.publishedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
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

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Starts the fake. Close it after the tests: it holds a listening socket,
 * and close() is where an unread violation fails the run.
 */
export async function startFakeOpampServer(options: FakeOpampServerOptions = {}): Promise<FakeOpampServer> {
  const { operations, errorReply: errorEnvelope } = theContract();
  const secret = options.secret ?? FAKE_OPAMP_SERVER_SECRET;
  const now = options.now ?? (() => new Date());
  const organizations = new Map<string, StoredOrganization>();
  /**
   * The publications, by organization and id (publicationKey): every read
   * names its organization, so none can reach another's by its id alone.
   * The id is still unique across organizations, as the real table's
   * primary key makes it: a POST of another organization's id is 409.
   */
  const publications = new Map<string, StoredPublication>();
  /** The publications markPublicationInUse marked, by organization and id: each one phantom pinned collector. */
  const inUse = new Set<string>();
  const publicationKey = (organizationId: string, id: string) => `${organizationId}/${id}`;
  const violations: string[] = [];
  let pendingFault: FakeOpampServerFault | undefined;
  /** One-shot faults for the next request of an operation, by operationId. */
  const operationFaults = new Map<string, FakeOpampServerFault>();
  const ownPublication = (organizationId: string, id: string) => publications.get(publicationKey(organizationId, id));
  const modelPublication = (p: StoredPublication) => ({
    id: p.id,
    sha256: p.sha256,
    version: { ...p.version },
    publishedAt: p.publishedAt,
    names: [...p.names],
  });
  // The variables model reads the fleet model's uses, and the fleet model
  // the variables model's checks and stamps: each through the other's
  // methods, called only once both exist.
  const variablesModel = createVariablesModel({
    now,
    publicationsNaming: (organizationId, name) =>
      [...publications.values()].filter((p) => p.organizationId === organizationId && p.names.includes(name)).map((p) => p.id),
    publicationUses: (organizationId, publicationId) => fleetModel.publicationUses(organizationId, publicationId),
    variableGroupUses: (organizationId, variableGroupId) => fleetModel.variableGroupUses(organizationId, variableGroupId),
  });
  const fleetModel = createFleetModel({
    now,
    publication(organizationId, id) {
      const stored = ownPublication(organizationId, id);
      return stored === undefined ? undefined : modelPublication(stored);
    },
    publicationsOf(organizationId, configurationId) {
      return [...publications.values()]
        .filter((p) => p.organizationId === organizationId && p.configuration.id === configurationId)
        .map(modelPublication);
    },
    isMarkedInUse: (organizationId, id) => inUse.has(publicationKey(organizationId, id)),
    variables: variablesModel,
  });
  /** In use: assigned to a group or pinned on a collector, or marked. */
  const isInUse = (organizationId: string, id: string) =>
    inUse.has(publicationKey(organizationId, id)) || fleetModel.publicationUsed(organizationId, id);
  /** Deletes the publication, and each collector served it loses the pointer (keeping the hash). */
  const deleteStoredPublication = (organizationId: string, id: string) => {
    publications.delete(publicationKey(organizationId, id));
    fleetModel.publicationDeleted(organizationId, id);
  };

  /**
   * The fault this request takes: one for its operation first, then one for
   * any. With `only` (the reset, taken before the body is read), a request
   * whose operation has a fault of another kind takes none: its own fault
   * comes later, and one for any stays pending.
   */
  function takeFault(operationId: string, only?: FakeOpampServerFault): FakeOpampServerFault | undefined {
    const forOperation = operationFaults.get(operationId);
    if (forOperation !== undefined) {
      if (only !== undefined && forOperation !== only) return undefined;
      operationFaults.delete(operationId);
      return forOperation;
    }
    const any = pendingFault;
    if (any !== undefined && (only === undefined || any === only)) {
      pendingFault = undefined;
      return any;
    }
    return undefined;
  }

  function violation(message: string): void {
    violations.push(message);
    options.onViolation?.(message);
  }

  /** The request's violations of `operation`'s contract, recorded; the parsed parts for the semantics. */
  function checkRequest(
    operation: ContractOperation,
    request: IncomingMessage,
    url: URL,
    pathValues: Map<string, string>,
    body: Buffer,
  ): { badPath: string | undefined; badQuery: string | undefined; query: Map<string, string> } {
    const where = `${operation.operationId} request`;
    // The real server reads the path's ids first, then the organization,
    // then the query, so the two are answered apart.
    const bad: { path: string | undefined; query: string | undefined } = { path: undefined, query: undefined };
    const query = new Map<string, string>();
    for (const parameter of operation.parameters) {
      let value: string | number | undefined;
      if (parameter.in === "path") {
        value = pathValues.get(parameter.name);
      } else {
        const values = url.searchParams.getAll(parameter.name);
        if (values.length > 1) {
          violation(`${where}: query parameter ${parameter.name} is given more than once`);
          bad.query ??= `${parameter.name} must be given once.`;
        }
        value = values[0];
        if (value !== undefined) query.set(parameter.name, value);
      }
      if (value === undefined) {
        if (parameter.required) {
          violation(`${where}: ${parameter.in} parameter ${parameter.name} is required`);
          bad[parameter.in] ??= `${parameter.name} is required.`;
        }
        continue;
      }
      const candidate = parameter.isInteger && /^-?\d+$/.test(value) ? Number(value) : value;
      if (!parameter.validate(candidate)) {
        violation(
          `${where}: ${parameter.in} parameter ${parameter.name} ${describeErrors(parameter.validate.errors)}`,
        );
        bad[parameter.in] ??= `${parameter.name} is invalid.`;
      }
    }
    const documented = new Set(operation.parameters.filter((p) => p.in === "query").map((p) => p.name));
    for (const name of new Set(url.searchParams.keys())) {
      if (!documented.has(name)) violation(`${where}: query parameter ${name} isn't documented`);
    }

    const contentType = singleHeader(request.headers, "content-type");
    if (operation.requestBody === undefined) {
      if (body.length > 0) violation(`${where}: has a body, which the operation doesn't take`);
    } else if (mediaTypeOf(contentType) !== operation.requestBody.mediaType) {
      violation(`${where}: Content-Type isn't ${operation.requestBody.mediaType}`);
    } else {
      let parsed: Json | undefined;
      try {
        parsed = JSON.parse(body.toString("utf8")) as Json;
      } catch {
        violation(`${where}: the body isn't JSON`);
      }
      if (parsed !== undefined && !operation.requestBody.validate(parsed)) {
        violation(`${where} body: ${describeErrors(operation.requestBody.validate.errors)}`);
      }
    }
    return { badPath: bad.path, badQuery: bad.query, query };
  }

  /** Records the reply's violations of the contract: its status, headers and body. */
  function checkReply(operation: ContractOperation | undefined, reply: Reply): void {
    if (operation === undefined) {
      // A request no operation matches: the file's 401 or 404 envelope.
      if (!errorEnvelope(reply.body)) violation(`reply ${reply.status}: ${describeErrors(errorEnvelope.errors)}`);
      return;
    }
    const where = `${operation.operationId} reply ${reply.status}`;
    const documented = operation.responses.get(String(reply.status));
    if (documented === undefined) {
      violation(`${where}: the status isn't documented`);
      return;
    }
    for (const header of documented.headers) {
      const value = reply.headers[header.name];
      if (value === undefined) {
        if (header.required) violation(`${where}: header ${header.name} is missing`);
      } else if (!header.validate(value)) {
        violation(`${where}: header ${header.name} ${describeErrors(header.validate.errors)}`);
      }
    }
    if (documented.content === undefined) {
      if (reply.body !== undefined) violation(`${where}: has a body, which the status doesn't`);
      return;
    }
    if (mediaTypeOf(reply.headers["content-type"]) !== documented.content.mediaType) {
      violation(`${where}: Content-Type isn't ${documented.content.mediaType}`);
    }
    if (!documented.content.validate(reply.body)) {
      violation(`${where} body: ${describeErrors(documented.content.validate.errors)}`);
    }
  }

  /**
   * The JSON body `operationId` takes, checked as the real server checks it:
   * the Content-Type, the 2 MiB cap, JSON, then the schema. A Reply when it
   * is refused.
   */
  function readJsonBody(operationId: string, request: IncomingMessage, body: Buffer): Json | Reply {
    const contentType = singleHeader(request.headers, "content-type");
    const parameters = contentType?.split(";").slice(1) ?? [];
    if (
      mediaTypeOf(contentType) !== "application/json" ||
      !parameters.every((parameter) => /^\s*charset\s*=\s*"?utf-8"?\s*$/i.test(parameter))
    ) {
      return invalidRequest("Content-Type must be application/json.");
    }
    if (body.length > MAX_BODY_BYTES) return payloadTooLarge();
    let parsed: Json;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Json;
    } catch {
      return invalidRequest("The request body must be a JSON object.");
    }
    const validate = operations.find((o) => o.operationId === operationId)?.requestBody?.validate;
    if (validate === undefined || !validate(parsed)) {
      // checkRequest recorded the violation; the real server names the field.
      return invalidRequest("The request body doesn't match the API.");
    }
    return parsed;
  }

  /** POST /api/v1/organizations: 201 registered, 200 the same id and name again, 409 another name. */
  function createOrganization(request: IncomingMessage, body: Buffer): Reply {
    const parsed = readJsonBody("createOrganization", request, body);
    if (isReply(parsed)) return parsed;
    const fields = parsed as { id?: string; name: string };
    // As Postgres's uuid gives it back; without one, a version 4 UUID.
    const id = fields.id?.toLowerCase() ?? randomUUID();
    const stored = organizations.get(id);
    if (stored !== undefined) {
      // Compared exactly as sent: the server neither trims nor folds case.
      if (stored.name === fields.name) return json(200, { organizationId: id });
      return errorReply(409, "organization_conflict", "An organization with this id is already registered under another name.");
    }
    const at = now().getTime();
    organizations.set(id, { id, name: fields.name, createdAt: at, updatedAt: at });
    return json(201, { organizationId: id });
  }

  /** PATCH /api/v1/organizations/{id}: the body first, then 404; the same name changes nothing, updatedAt included. */
  function renameOrganization(organizationId: string, request: IncomingMessage, body: Buffer): Reply {
    const parsed = readJsonBody("renameOrganization", request, body);
    if (isReply(parsed)) return parsed;
    const { name } = parsed as { name: string };
    const stored = organizations.get(organizationId);
    if (stored === undefined) return notFound();
    if (stored.name !== name) {
      stored.name = name;
      stored.updatedAt = now().getTime();
    }
    return json(200, organizationJson(stored));
  }

  /**
   * POST …/publications (0.2.4): the caller's `id` from the body, or one the
   * server makes (then every such call stores a new publication); 201
   * stored, 200 an identical one already stored under the id, 409 the id
   * taken by a different one (another organization's included).
   */
  function postPublication(organizationId: string, request: IncomingMessage, body: Buffer): Reply {
    const parsed = readJsonBody("postPublication", request, body);
    if (isReply(parsed)) return parsed;
    const fields = parsed as unknown as Omit<StoredPublication, "id" | "organizationId" | "publishedAt" | "receivedAt"> & {
      id?: string;
      publishedAt: string;
    };
    // As Postgres's uuid gives it back: lower case.
    const publicationId = fields.id?.toLowerCase() ?? randomUUID();
    const publishedAt = toMilliseconds(fields.publishedAt);
    if (Number.isNaN(publishedAt)) {
      // A leap second: RFC 3339 has one, Go's time.Parse doesn't.
      return invalidRequest("publishedAt must be an RFC 3339 date-time.");
    }
    if (publishedAt < EARLIEST_INSTANT || publishedAt >= AFTER_LATEST_INSTANT) {
      // A date-time in the text, but an instant no reply could write.
      return invalidRequest("publishedAt must be from the year 0001 to 9999, in UTC.");
    }
    if (Buffer.byteLength(fields.yaml, "utf8") > MAX_YAML_BYTES) {
      return invalidRequest(`yaml must be 1 to ${MAX_YAML_BYTES} bytes of UTF-8.`);
    }
    if (createHash("sha256").update(fields.yaml, "utf8").digest("hex") !== fields.sha256) {
      return errorReply(422, "sha256_mismatch", "sha256 isn't the SHA-256 of yaml's UTF-8 bytes.");
    }
    // A live reference to a name no variable can have is refused before
    // anything is written, after the 422.
    const names = variableReferences(fields.yaml);
    if (names.some((name) => name.length > MAX_VARIABLE_NAME_LENGTH)) return invalidRequest(REFERENCE_TOO_LONG);
    const candidate: StoredPublication = {
      id: publicationId,
      organizationId,
      configuration: { id: fields.configuration.id.toLowerCase(), name: fields.configuration.name },
      version: { id: fields.version.id.toLowerCase(), number: fields.version.number, label: fields.version.label },
      yaml: fields.yaml,
      sha256: fields.sha256,
      publishedBy:
        fields.publishedBy === null ? null : { id: fields.publishedBy.id.toLowerCase(), email: fields.publishedBy.email },
      publishedAt,
      receivedAt: now().getTime(),
      collector: { distribution: fields.collector.distribution, version: fields.collector.version },
      names,
    };
    const stored = ownPublication(organizationId, publicationId);
    if (stored === undefined) {
      // Another organization's id: the real table's primary key is the id alone.
      if ([...publications.values()].some((p) => p.id === publicationId)) {
        return errorReply(409, "publication_conflict", "A different publication already has this id.");
      }
      publications.set(publicationKey(organizationId, publicationId), candidate);
      return { status: 201, headers: { "content-type": "application/json" }, body: publicationJson(candidate, true) };
    }
    if (isIdentical(stored, candidate)) {
      return { status: 200, headers: { "content-type": "application/json" }, body: publicationJson(stored, true) };
    }
    return errorReply(409, "publication_conflict", "A different publication already has this id.");
  }

  function listPublications(organizationId: string, query: Map<string, string>): Reply {
    const configurationId = query.get("configurationId")?.toLowerCase() ?? "";
    let limit = DEFAULT_LIST_LIMIT;
    const rawLimit = query.get("limit");
    if (rawLimit !== undefined) {
      limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
      if (limit < 1 || limit > 100) return invalidRequest("limit must be an integer from 1 to 100.");
    }
    const rawCursor = query.get("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === undefined) return invalidRequest("cursor isn't one this API gave.");

    const matching = [...publications.values()]
      .filter((p) => p.organizationId === organizationId && p.configuration.id === configurationId)
      .filter((p) => cursor === undefined || newestFirst(cursor, p) < 0)
      .sort(newestFirst);
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        publications: page.map((p) => publicationJson(p, false)),
        nextCursor: matching.length > limit && last !== undefined ? encodeCursor(last) : null,
      },
    };
  }

  /** The real server's answer to an authenticated request for `operation`. */
  function answer(
    operation: ContractOperation,
    request: IncomingMessage,
    pathValues: Map<string, string>,
    query: Map<string, string>,
    body: Buffer,
  ): Reply {
    const modelRequest = {
      operationId: operation.operationId,
      organizationId: pathValues.get("organizationId")?.toLowerCase() ?? "",
      pathValues,
      query,
      readBody: () => readJsonBody(operation.operationId, request, body),
      bodyText: body.toString("utf8"),
    };
    const modelReply = fleetModel.answer(modelRequest) ?? variablesModel.answer(modelRequest);
    if (modelReply !== undefined) return modelReply;
    // Ids as Postgres's uuid gives them back: lower case.
    const organizationId = pathValues.get("organizationId")?.toLowerCase() ?? "";
    const publicationId = pathValues.get("publicationId")?.toLowerCase() ?? "";
    switch (operation.operationId) {
      case "createOrganization":
        return createOrganization(request, body);
      case "getOrganization": {
        const stored = organizations.get(organizationId);
        return stored === undefined ? notFound() : json(200, organizationJson(stored));
      }
      case "renameOrganization":
        return renameOrganization(organizationId, request, body);
      case "deleteOrganization": {
        if (!organizations.delete(organizationId)) return notFound();
        // The cascade: everything it owned goes with it, its fleets (and so
        // its uses of its publications) included.
        fleetModel.deleteOrganization(organizationId);
        variablesModel.deleteOrganization(organizationId);
        for (const [key, stored] of publications) {
          if (stored.organizationId === organizationId) {
            publications.delete(key);
            inUse.delete(key);
          }
        }
        return noContent();
      }
      case "postPublication":
        return postPublication(organizationId, request, body);
      case "getPublication": {
        const stored = ownPublication(organizationId, publicationId);
        if (stored === undefined) return notFound();
        return { status: 200, headers: { "content-type": "application/json" }, body: publicationJson(stored, true) };
      }
      case "deletePublication": {
        if (ownPublication(organizationId, publicationId) === undefined) return notFound();
        if (isInUse(organizationId, publicationId)) {
          return errorReply(409, "publication_in_use", "A collector group or a collector uses this published version.");
        }
        deleteStoredPublication(organizationId, publicationId);
        return noContent();
      }
      case "listPublications":
        return listPublications(organizationId, query);
      case "deleteConfigurationPublications": {
        const configurationId = pathValues.get("configurationId")?.toLowerCase();
        const matching = [...publications.values()].filter(
          (stored) => stored.organizationId === organizationId && stored.configuration.id === configurationId,
        );
        // One statement in the real server: refused whole while any is used.
        if (matching.some((stored) => isInUse(organizationId, stored.id))) {
          return errorReply(
            409,
            "publication_in_use",
            "A collector group or a collector uses one of the configuration's published versions.",
          );
        }
        for (const stored of matching) deleteStoredPublication(organizationId, stored.id);
        return noContent();
      }
      default:
        throw new Error(`the fake doesn't implement ${operation.operationId}`);
    }
  }

  /** `reply` made to break the contract, for the `malformed_reply` fault. */
  function malformed(reply: Reply): Reply {
    if (reply.body === undefined) return { status: 200, headers: { "content-type": "application/json" }, body: {} };
    if (typeof reply.body === "object" && reply.body !== null && !Array.isArray(reply.body)) {
      const [, ...rest] = Object.entries(reply.body);
      return { ...reply, body: Object.fromEntries(rest) };
    }
    return { ...reply, body: { unexpected: true } };
  }

  function send(response: ServerResponse, reply: Reply): void {
    const payload =
      reply.body === undefined ? undefined : reply.isText ? String(reply.body) : JSON.stringify(reply.body);
    response.writeHead(reply.status, reply.headers);
    response.end(payload);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-opamp-server.invalid");
    const method = request.method ?? "GET";
    const routed = operations.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname));
    if (takeFault(routed?.operationId ?? "", "reset") !== undefined) {
      request.socket.resetAndDestroy();
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      violation(`${request.method} request: the body is larger than the fake reads`);
      request.socket.destroy();
      return;
    }

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
      // GET /health: no secret, no database.
      const reply: Reply = {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "ok",
        isText: true,
      };
      checkRequest(operation, request, url, pathValues, body);
      checkReply(operation, reply);
      send(response, reply);
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      violation(`${method} ${url.pathname}: the route isn't documented`);
      const reply = notFound();
      checkReply(undefined, reply);
      send(response, reply);
      return;
    }

    // Authentication comes before routing, as the real server's does. A
    // request without the Bearer scheme breaks the security scheme; a
    // wrong secret is a documented 401.
    const token = /^bearer +(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      violation(`${operation?.operationId ?? `${method} ${url.pathname}`} request: no Authorization: Bearer header`);
    }
    if (token !== secret) {
      const reply = unauthorized();
      checkReply(operation, reply);
      send(response, reply);
      return;
    }
    if (operation === undefined) {
      violation(`${method} ${url.pathname}: the route isn't documented`);
      const reply = notFound();
      checkReply(undefined, reply);
      send(response, reply);
      return;
    }

    const { badPath, badQuery, query } = checkRequest(operation, request, url, pathValues, body);
    const fault = takeFault(operation.operationId);
    if (fault === "hang") return;

    let reply: Reply;
    if (fault === "error_500") {
      reply = errorReply(500, "internal_error", "Internal server error.");
    } else if (badPath !== undefined) {
      reply = invalidRequest(badPath);
    } else if (
      operation.pathParameterNames.includes("organizationId") &&
      !REGISTRY_OPERATIONS.has(operation.operationId) &&
      !organizations.has(pathValues.get("organizationId")?.toLowerCase() ?? "")
    ) {
      // Once the path's ids are read, before the query or the body.
      reply = organizationNotFound();
    } else if (badQuery !== undefined) {
      reply = invalidRequest(badQuery);
    } else {
      reply = answer(operation, request, pathValues, query, body);
    }
    if (fault === "malformed_reply") reply = malformed(reply);
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
    nextFault(fault, operationId) {
      if (operationId === undefined) {
        pendingFault = fault;
        return;
      }
      if (!operations.some((operation) => operation.operationId === operationId)) {
        throw new Error("nextFault: the contract has no such operation");
      }
      operationFaults.set(operationId, fault);
    },
    markPublicationInUse(organizationId, publicationId, used = true) {
      const key = publicationKey(organizationId.toLowerCase(), publicationId.toLowerCase());
      if (!publications.has(key)) {
        throw new Error("markPublicationInUse: the organization holds no such publication");
      }
      if (used) inUse.add(key);
      else inUse.delete(key);
    },
    enrollCollector: (organizationId, fleetId, enroll) => fleetModel.enrollCollector(organizationId, fleetId, enroll),
    setCollectorState: (organizationId, collectorId, changes) =>
      fleetModel.setCollectorState(organizationId, collectorId, changes),
    recordCollectorError: (organizationId, collectorId, report) =>
      fleetModel.recordCollectorError(organizationId, collectorId, report),
    recordTokenEvents: (organizationId, fleetId, seeding) => fleetModel.recordTokenEvents(organizationId, fleetId, seeding),
    snapshotOf(organizationId) {
      const id = organizationId.toLowerCase();
      const organization = organizations.get(id);
      const owned = [...publications.values()]
        .filter((p) => p.organizationId === id)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        organization: organization === undefined ? null : structuredClone(organization),
        publications: structuredClone(owned),
        markedInUse: owned.filter((p) => inUse.has(publicationKey(id, p.id))).map((p) => p.id),
        ...fleetModel.snapshotOf(id),
        ...variablesModel.snapshotOf(id),
      };
    },
    takeViolations() {
      return violations.splice(0);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
      if (violations.length > 0) {
        throw new Error(`The fake opamp-server saw contract violations no test read:\n${violations.join("\n")}`);
      }
    },
  };
}
