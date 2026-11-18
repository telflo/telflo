import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { createOpampServerClient, type OpampServerClient } from "../../apps/api/src/opamp-server/client.js";
import {
  AFTER_LATEST_INSTANT,
  EARLIEST_INSTANT,
  type CollectorErrorReport,
  type CollectorStateChanges,
  type EnrollCollectorOptions,
  type EnrolledCollector,
  type ReportedState,
  type TokenEventKind,
  type TokenEventSeeding,
} from "../../apps/api/src/testing/fake-opamp-server-fleets.js";
import {
  FAKE_OPAMP_SERVER_SECRET,
  startFakeOpampServer,
  type FakeOpampServer,
} from "../../apps/api/src/testing/fake-opamp-server.js";
import { E2E_OPAMP_CONTROL_URL, E2E_OPAMP_URL } from "./environment.js";

// The browser tests' opamp-server (D11b decision 8): the OpenAPI-checked fake
// from apps/api/src/testing, which start-fake-opamp-server.ts runs as a
// Playwright web server. The fake checks every request the E2E API sends it,
// and every reply it sends, against vendor/opamp-server/openapi.yaml.
// In a vitest file, close() fails the file on an unread violation; here the
// fake runs in a process of its own, which Playwright kills when the run ends,
// so nothing would read them. Instead each violation, as the fake sees it,
// is written to stderr (Playwright shows a web server's stderr) and appended
// to a file, and global-setup.ts's teardown, which runs before the web
// servers stop, fails the run if the file holds any
// (assertNoFakeOpampServerViolations).
//
// A violation names an operation, a field or a path, never a value: the
// fake's messages carry no secret, YAML or name.
//
// The browser tests read what the E2E API published from the fake's own
// management API (fakeSnapshots), with the platform's client.

export interface E2eFakeOpampServerOptions {
  port: number;
  /** Emptied now; each violation is appended as one line. */
  violationsPath: string;
  /** Where each violation is also written as it is seen. Default process.stderr. */
  stderr?: { write(text: string): unknown };
}

/** Starts the fake on 127.0.0.1:`port`, recording each violation to `violationsPath` and `stderr`. */
export async function startE2eFakeOpampServer(options: E2eFakeOpampServerOptions): Promise<FakeOpampServer> {
  const { port, violationsPath } = options;
  const stderr = options.stderr ?? process.stderr;
  mkdirSync(dirname(violationsPath), { recursive: true });
  writeFileSync(violationsPath, "");
  return startFakeOpampServer({
    port,
    onViolation(message) {
      // One violation per line, whatever the message holds.
      const line = message.replace(/\s+/g, " ");
      appendFileSync(violationsPath, `${line}\n`);
      stderr.write(`fake opamp-server: contract violation: ${line}\n`);
    },
  });
}

/**
 * Throws, listing them, if the fake recorded any violation, and if the file
 * is missing (the fake never started, or something else removed it).
 */
export function assertNoFakeOpampServerViolations(violationsPath: string): void {
  let text: string;
  try {
    text = readFileSync(violationsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The fake opamp-server's violations file is missing (${violationsPath}): did it start?`);
    }
    throw error;
  }
  const violations = text.split("\n").filter((line) => line !== "");
  if (violations.length > 0) {
    throw new Error(
      `The fake opamp-server saw ${violations.length} contract violation(s) from the E2E API:\n${violations.join("\n")}`,
    );
  }
}

/** A snapshot the E2E API put in the fake (D11b decision 11), as the fake holds it. */
export interface FakeSnapshot {
  publicationId: string;
  versionId: string;
  versionNumber: number;
  yaml: string;
  /** The collector it was published for (D13a decision 7): the configuration's distribution and the version's pin. */
  collector: { distribution: string; version: string };
}

/**
 * The collector a snapshot of a version should hold: the version row's
 * distribution and pin, as the database holds them (D13a decision 7).
 */
export function collectorOf(version: { collector_distribution: string; collector_version: string }): FakeSnapshot["collector"] {
  return { distribution: version.collector_distribution, version: version.collector_version };
}

let fakeClient: OpampServerClient | undefined;

/**
 * The snapshots of `configurationId` that the browser tests' fake holds,
 * newest first, each with its YAML and its collector: read through the fake's own management
 * API with its public test secret, by the platform's client, as the E2E API
 * talks to it. None when the fake doesn't know the organization. The fake is
 * shared by every test, so a test reads only its own configuration's.
 */
export async function fakeSnapshots(organizationId: string, configurationId: string): Promise<FakeSnapshot[]> {
  fakeClient ??= createOpampServerClient({ url: E2E_OPAMP_URL, secret: FAKE_OPAMP_SERVER_SECRET });
  const client = fakeClient;
  const listed = await client.listPublications(organizationId, { configurationId, limit: 100 });
  if (listed.kind === "organization_not_found") return [];
  if (listed.kind !== "page") throw new Error(`the fake opamp-server's list answered ${listed.kind}`);
  return Promise.all(
    listed.page.publications.map(async (summary) => {
      const found = await client.getPublication(organizationId, summary.id);
      if (found.kind !== "found") throw new Error(`the fake opamp-server's get answered ${found.kind}`);
      return {
        publicationId: summary.id,
        versionId: summary.version.id,
        versionNumber: summary.version.number,
        yaml: found.publication.yaml,
        collector: found.publication.collector,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// The control port (D17a decision 30, Preflight ruling 6): test-only, on a
// port of its own, as the collector tester's (D14a Ruling 36).
//
// The fleet screens show collectors, which only a collector's poll makes on
// the real server. The browser tests make them here instead, thin over the
// fake's own helpers. start-fake-opamp-server.ts serves it beside the fake,
// in the fake's process, on E2E_OPAMP_CONTROL_PORT (127.0.0.1):
// - POST /organizations/{o}/fleets/{f}/collectors {name?, groupId?, tokenId?,
//   lastSeenAt?, reported?}: enrollCollector, 201 {id, instanceUid, name}
//   (on the fleet's default token unless one is named, seen now unless
//   lastSeenAt);
// - PATCH /organizations/{o}/collectors/{c} {lastSeenAt?, served?,
//   effective?, reported?}: setCollectorState, 204. `reported` is
//   {collectorVersion?, ip?, hostIp?, attributes?}, each scalar a string or
//   null, attributes null or an object of string values, which the fake
//   bounds as the agent side does (D17b-1 decision 33, Preflight ruling 3);
//   `served` is {kind: "publication", id, sha256?, at?} or {kind: null,
//   sha256, at?} (a published version deleted since);
// - POST /organizations/{o}/collectors/{c}/errors {message, configSha256?,
//   reportedAt?}: recordCollectorError, 201 {id} (the message cut to 8 KiB,
//   the newest 100 kept, no 30-day window: seed recent dates);
// - POST /organizations/{o}/fleets/{f}/token-events {count, event?, tokenId?,
//   actor?, occurredAt?}: recordTokenEvents, 201 {count}: `count` (1 to
//   500) events of one kind (issued, viewed, rotated or revoked; default
//   viewed) on one of the fleet's tokens (default its default token), by
//   `actor` ({id, email} or null; default null), the newest at occurredAt
//   (default now) and each next a millisecond earlier: the token history's
//   paging (D17b-2 decision 21);
// - a helper's refusal (a fleet, group, token or collector the organization
//   doesn't hold, a dead token, an archived fleet, a taken name, a served
//   target it doesn't hold, a message empty once bounded) is 409 with the
//   helper's fixed message; a body that isn't JSON, or isn't the shape
//   above (a date not ISO 8601 or, its offset applied, outside the years
//   0001 to 9999 UTC, whose first and last instants are taken, a sha256
//   not 64 lowercase hex digits, a served kind other than publication or
//   null, more than 64 KiB, read to its end before the 400), is 400;
//   anything else is 404 (the imports path among them: D16c removed
//   importing).
// Every answer but a 204 is JSON, `{"error": "..."}` when refused, and
// names a field, never a value it was sent. Assignments and pins stay on the contract's
// routes (the platform's group and collector PATCH). It isn't a route of the
// contract, so the fake's own port answers its paths as undocumented
// (fake-opamp-server.test.ts); the E2E API never calls it, and it never
// ships (it lives under e2e/).

/** What a test may set when it enrolls a collector through the control port (the dates sent as ISO 8601). */
export type FakeCollectorEnrollment = Pick<EnrollCollectorOptions, "name" | "groupId" | "tokenId" | "lastSeenAt" | "reported">;
/** What a test may change of a collector through the control port (the dates sent as ISO 8601). */
export type FakeCollectorChanges = Pick<CollectorStateChanges, "lastSeenAt" | "served" | "effective" | "reported">;
/** A failure a test records for a collector through the control port (the date sent as ISO 8601). */
export type FakeCollectorError = CollectorErrorReport;
/** The control port's bodies are small; anything larger is drained, unkept, and refused. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const ENROLL_PATH = /^\/organizations\/([^/]+)\/fleets\/([^/]+)\/collectors$/;
const COLLECTOR_PATH = /^\/organizations\/([^/]+)\/collectors\/([^/]+)$/;
const ERRORS_PATH = /^\/organizations\/([^/]+)\/collectors\/([^/]+)\/errors$/;
const TOKEN_EVENTS_PATH = /^\/organizations\/([^/]+)\/fleets\/([^/]+)\/token-events$/;

/** The control port's routes: a method and a path, each naming two ids. */
const CONTROL_ROUTES = [
  { method: "POST", path: ENROLL_PATH, route: "enroll" },
  { method: "PATCH", path: COLLECTOR_PATH, route: "change" },
  { method: "POST", path: ERRORS_PATH, route: "error" },
  { method: "POST", path: TOKEN_EVENTS_PATH, route: "token-events" },
] as const;

/** A control request's refusal: its status and fixed message. */
class ControlRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Serves the control port for the fake on 127.0.0.1:`port` (0 for any free
 * one). Given the fake as a promise, so it can listen before the fake does:
 * Playwright waits for the fake's /health, and the control port is then
 * already there.
 */
export async function startFakeOpampServerControl(fakeStarted: Promise<FakeOpampServer>, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    void answerControl(fakeStarted, request, response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  return server;
}

/** One control request, answered once the fake has started. */
async function answerControl(fakeStarted: Promise<FakeOpampServer>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body?: unknown) => {
    if (body === undefined) {
      response.writeHead(status);
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  try {
    const url = new URL(request.url ?? "/", "http://fake-opamp-server-control.invalid");
    let matched: { route: (typeof CONTROL_ROUTES)[number]["route"]; ids: RegExpExecArray } | undefined;
    for (const { method, path, route } of CONTROL_ROUTES) {
      const ids = request.method === method ? path.exec(url.pathname) : null;
      if (ids !== null) {
        matched = { route, ids };
        break;
      }
    }
    if (matched === undefined) {
      request.resume();
      throw new ControlRefusal(404, "no such route");
    }
    const body = controlJson(await readControlBody(request));
    const fake = await fakeStarted;
    const [organizationId, id] = pathIds(matched.ids);
    switch (matched.route) {
      case "enroll": {
        const enrollment = enrollmentOf(body);
        return reply(201, refusedAsConflict(() => fake.enrollCollector(organizationId, id, enrollment)));
      }
      case "change": {
        const changes = changesOf(body);
        refusedAsConflict(() => fake.setCollectorState(organizationId, id, changes));
        return reply(204);
      }
      case "error": {
        const report = errorReportOf(body);
        return reply(201, refusedAsConflict(() => fake.recordCollectorError(organizationId, id, report)));
      }
      case "token-events": {
        const seeding = tokenEventSeedingOf(body);
        return reply(201, refusedAsConflict(() => fake.recordTokenEvents(organizationId, id, seeding)));
      }
    }
  } catch (error) {
    if (error instanceof ControlRefusal) return reply(error.status, { error: error.message });
    return reply(500, { error: "the control port failed" });
  }
}

/**
 * The request's body as text, or a 400 once it has all arrived when it is
 * larger than MAX_CONTROL_BODY_BYTES. An oversized body stops being kept but
 * is read to its end (drained), so the 400 reaches the client: leaving a
 * `for await` loop mid-body destroyed the request, and a far-oversized body
 * (256 KiB, 8 MiB) met a reset connection instead (Task 4 review).
 */
function readControlBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (size > MAX_CONTROL_BODY_BYTES) fail(new ControlRefusal(400, "the body is too large"));
      else done(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", fail);
  });
}

function pathIds(match: RegExpExecArray): [string, string] {
  try {
    return [decodeURIComponent(match[1] as string), decodeURIComponent(match[2] as string)];
  } catch {
    throw new ControlRefusal(404, "no such route");
  }
}

/** The helper's answer; its throw (a fixed message, no value) is a 409. */
function refusedAsConflict<T>(helper: () => T): T {
  try {
    return helper();
  } catch (error) {
    throw new ControlRefusal(409, error instanceof Error ? error.message : "refused");
  }
}

type ControlObject = Record<string, unknown>;

function controlJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlRefusal(400, "the body isn't JSON");
  }
}

/** `value` as an object holding only `allowed` keys, or a 400 naming `what`. */
function objectOf(value: unknown, what: string, allowed: readonly string[]): ControlObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ControlRefusal(400, `${what} isn't an object`);
  const object = value as ControlObject;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new ControlRefusal(400, `${what} holds a field the control port doesn't take`);
  }
  return object;
}

function stringOf(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ControlRefusal(400, `${field} isn't a string`);
  return value;
}

/** A SHA-256 as the contract holds it: 64 lowercase hex digits. */
const SHA256 = /^[0-9a-f]{64}$/;
/** An ISO 8601 date and time with its offset, as the helpers send (Date's toJSON). */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO 8601 date the server could store: an instant, once its offset is
 * applied, in the years 0001 to 9999 UTC (D11a Ruling 30), so the fake's
 * replies stay within the contract's date-time.
 */
function dateOf(value: unknown, field: string): Date {
  const text = stringOf(value, field);
  const date = new Date(text);
  if (!ISO_8601.test(text) || Number.isNaN(date.getTime())) throw new ControlRefusal(400, `${field} isn't an ISO 8601 date`);
  if (date.getTime() < EARLIEST_INSTANT || date.getTime() >= AFTER_LATEST_INSTANT) {
    throw new ControlRefusal(400, `${field} isn't in the years 0001 to 9999 UTC`);
  }
  return date;
}

/** A SHA-256 the contract would carry, or a fixed 400 naming the field, never the value (Task 2 review, Minor 1). */
function sha256Of(value: unknown, field: string): string {
  const text = stringOf(value, field);
  if (!SHA256.test(text)) throw new ControlRefusal(400, `${field} isn't a SHA-256`);
  return text;
}

/** A string, or null, or a 400 naming the field. */
function nullableStringOf(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ControlRefusal(400, `${field} isn't a string or null`);
  return value;
}

/**
 * What a collector reports of itself, its types checked here; its values
 * the fake's reportedOf bounds, as the agent side does (an out-of-bound
 * version or address keeping the stored one, attributes as
 * boundedAttributes keeps them).
 */
function reportedStateOf(value: unknown): ReportedState {
  const fields = objectOf(value, "reported", ["collectorVersion", "ip", "hostIp", "attributes"]);
  const reported: ReportedState = {};
  for (const field of ["collectorVersion", "ip", "hostIp"] as const) {
    if (fields[field] !== undefined) reported[field] = nullableStringOf(fields[field], `reported.${field}`);
  }
  if (fields.attributes !== undefined) reported.attributes = attributesOf(fields.attributes);
  return reported;
}

function attributesOf(value: unknown): Record<string, string> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ControlRefusal(400, "reported.attributes isn't an object or null");
  const pairs = Object.entries(value as ControlObject);
  // An attribute's name and value are the collector's own text: neither is named.
  if (pairs.some(([, attribute]) => typeof attribute !== "string")) {
    throw new ControlRefusal(400, "reported.attributes holds a value that isn't a string");
  }
  return Object.fromEntries(pairs) as Record<string, string>;
}

function enrollmentOf(body: unknown): EnrollCollectorOptions {
  const fields = objectOf(body, "the body", ["name", "groupId", "tokenId", "lastSeenAt", "reported"]);
  const enrollment: EnrollCollectorOptions = {};
  if (fields.name !== undefined) enrollment.name = stringOf(fields.name, "name");
  if (fields.groupId !== undefined) enrollment.groupId = stringOf(fields.groupId, "groupId");
  if (fields.tokenId !== undefined) enrollment.tokenId = stringOf(fields.tokenId, "tokenId");
  if (fields.lastSeenAt !== undefined) enrollment.lastSeenAt = dateOf(fields.lastSeenAt, "lastSeenAt");
  if (fields.reported !== undefined) enrollment.reported = reportedStateOf(fields.reported);
  return enrollment;
}

function changesOf(body: unknown): CollectorStateChanges {
  const fields = objectOf(body, "the body", ["lastSeenAt", "served", "effective", "reported"]);
  const changes: CollectorStateChanges = {};
  if (fields.lastSeenAt !== undefined) changes.lastSeenAt = dateOf(fields.lastSeenAt, "lastSeenAt");
  if (fields.served !== undefined) changes.served = servedOf(fields.served);
  if (fields.effective !== undefined) changes.effective = effectiveOf(fields.effective);
  if (fields.reported !== undefined) changes.reported = reportedStateOf(fields.reported);
  return changes;
}

/** A failure to record: a message (the fake bounds it, and refuses one empty once bounded), its hash and when. */
function errorReportOf(body: unknown): CollectorErrorReport {
  const fields = objectOf(body, "the body", ["message", "configSha256", "reportedAt"]);
  const report: CollectorErrorReport = { message: stringOf(fields.message, "message") };
  if (fields.configSha256 !== undefined) {
    report.configSha256 = fields.configSha256 === null ? null : sha256Of(fields.configSha256, "configSha256");
  }
  if (fields.reportedAt !== undefined) report.reportedAt = dateOf(fields.reportedAt, "reportedAt");
  return report;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOKEN_EVENT_KINDS: readonly TokenEventKind[] = ["issued", "viewed", "rotated", "revoked"];

/** Token events to seed: how many (an integer, 1 to 500, the fake's bound), their kind, token, actor and newest time. */
function tokenEventSeedingOf(body: unknown): TokenEventSeeding {
  const fields = objectOf(body, "the body", ["count", "event", "tokenId", "actor", "occurredAt"]);
  if (typeof fields.count !== "number" || !Number.isInteger(fields.count) || fields.count < 1 || fields.count > 500) {
    throw new ControlRefusal(400, "count isn't an integer from 1 to 500");
  }
  const seeding: TokenEventSeeding = { count: fields.count };
  if (fields.event !== undefined) {
    if (!TOKEN_EVENT_KINDS.includes(fields.event as TokenEventKind)) throw new ControlRefusal(400, "event isn't issued, viewed, rotated or revoked");
    seeding.event = fields.event as TokenEventKind;
  }
  if (fields.tokenId !== undefined) seeding.tokenId = stringOf(fields.tokenId, "tokenId");
  if (fields.actor !== undefined) {
    if (fields.actor === null) seeding.actor = null;
    else {
      const actor = objectOf(fields.actor, "actor", ["id", "email"]);
      const id = stringOf(actor.id, "actor.id");
      const email = stringOf(actor.email, "actor.email");
      // The contract's Actor: a UUID, and an email of 1 to 320 characters without U+0000.
      if (!UUID.test(id)) throw new ControlRefusal(400, "actor.id isn't a UUID");
      if ([...email].length < 1 || [...email].length > 320) throw new ControlRefusal(400, "actor.email isn't 1 to 320 characters");
      if (email.includes("\u0000")) throw new ControlRefusal(400, "actor.email holds U+0000");
      seeding.actor = { id, email };
    }
  }
  if (fields.occurredAt !== undefined) seeding.occurredAt = dateOf(fields.occurredAt, "occurredAt");
  return seeding;
}

function servedOf(value: unknown): Exclude<CollectorStateChanges["served"], undefined> {
  if (value === null) return null;
  const served = objectOf(value, "served", ["kind", "id", "sha256", "at"]);
  const at = served.at === undefined ? undefined : served.at === null ? null : dateOf(served.at, "served.at");
  if (served.kind === null) {
    if (served.id !== undefined) throw new ControlRefusal(400, "served.id is set with no kind");
    return { kind: null, sha256: sha256Of(served.sha256, "served.sha256"), ...(at === undefined ? {} : { at }) };
  }
  if (served.kind !== "publication") throw new ControlRefusal(400, "served.kind isn't publication or null");
  return {
    kind: served.kind,
    id: stringOf(served.id, "served.id"),
    ...(served.sha256 === undefined ? {} : { sha256: sha256Of(served.sha256, "served.sha256") }),
    ...(at === undefined ? {} : { at }),
  };
}

function effectiveOf(value: unknown): Exclude<CollectorStateChanges["effective"], undefined> {
  if (value === null) return null;
  const effective = objectOf(value, "effective", ["sha256", "status", "error", "at"]);
  const status = effective.status;
  if (status !== "applied" && status !== "applying" && status !== "failed") {
    throw new ControlRefusal(400, "effective.status isn't applied, applying or failed");
  }
  return {
    sha256: sha256Of(effective.sha256, "effective.sha256"),
    status,
    ...(effective.error === undefined ? {} : { error: effective.error === null ? null : stringOf(effective.error, "effective.error") }),
    ...(effective.at === undefined ? {} : { at: dateOf(effective.at, "effective.at") }),
  };
}

/** Sends `body` (its dates as ISO 8601) to the control port; the reply's JSON, or a throw naming the refusal. */
async function control(
  controlUrl: string,
  what: string,
  request: { method: "POST" | "PATCH"; path: string; body: unknown; expected: 201 | 204 },
): Promise<unknown> {
  const response = await fetch(`${controlUrl}${request.path}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.body),
  });
  if (response.status !== request.expected) {
    const refusal = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(`The fake opamp-server's control port answered ${response.status} to ${what}: ${String(refusal.error ?? "no reason")}`);
  }
  return request.expected === 204 ? undefined : response.json();
}

/**
 * Enrolls a collector in the organization's fleet on the E2E API's fake, as
 * its first poll would (the fake's enrollCollector): in the Default group,
 * on the fleet's default token, seen now, reporting nothing, unless
 * `enrollment` says otherwise. Throws with the control port's refusal.
 */
export async function enrollFakeCollector(
  organizationId: string,
  fleetId: string,
  enrollment: FakeCollectorEnrollment = {},
  controlUrl: string = E2E_OPAMP_CONTROL_URL,
): Promise<EnrolledCollector> {
  const path = `/organizations/${encodeURIComponent(organizationId)}/fleets/${encodeURIComponent(fleetId)}/collectors`;
  return (await control(controlUrl, "enroll a collector", { method: "POST", path, body: enrollment, expected: 201 })) as EnrolledCollector;
}

/**
 * Sets when the organization's collector was last seen, what it was served
 * (a published version), what it reports running and what it
 * reports of itself, on the E2E API's fake (the fake's setCollectorState).
 * Throws with the control port's refusal.
 */
export async function setFakeCollectorState(
  organizationId: string,
  collectorId: string,
  changes: FakeCollectorChanges,
  controlUrl: string = E2E_OPAMP_CONTROL_URL,
): Promise<void> {
  const path = `/organizations/${encodeURIComponent(organizationId)}/collectors/${encodeURIComponent(collectorId)}`;
  await control(controlUrl, "set a collector's state", { method: "PATCH", path, body: changes, expected: 204 });
}

/**
 * Records a failure the organization's collector reported, on the E2E API's
 * fake (the fake's recordCollectorError): reported now unless the test
 * names a time. The history keeps its newest 100 and no 30-day window.
 * Throws with the control port's refusal.
 */
export async function recordFakeCollectorError(
  organizationId: string,
  collectorId: string,
  report: FakeCollectorError,
  controlUrl: string = E2E_OPAMP_CONTROL_URL,
): Promise<{ id: string }> {
  const path = `/organizations/${encodeURIComponent(organizationId)}/collectors/${encodeURIComponent(collectorId)}/errors`;
  return (await control(controlUrl, "record a collector's error", { method: "POST", path, body: report, expected: 201 })) as { id: string };
}

/** What a test may seed of a fleet's token history through the control port (the date sent as ISO 8601). */
export type FakeTokenEvents = TokenEventSeeding;

/**
 * Seeds the organization's fleet's token history on the E2E API's fake (the
 * fake's recordTokenEvents): `count` events, `viewed` on the default token
 * by no one, the newest now, unless the test says otherwise. Throws with the
 * control port's refusal.
 */
export async function recordFakeTokenEvents(
  organizationId: string,
  fleetId: string,
  events: FakeTokenEvents,
  controlUrl: string = E2E_OPAMP_CONTROL_URL,
): Promise<{ count: number }> {
  const path = `/organizations/${encodeURIComponent(organizationId)}/fleets/${encodeURIComponent(fleetId)}/token-events`;
  return (await control(controlUrl, "record a fleet's token events", { method: "POST", path, body: events, expected: 201 })) as { count: number };
}
