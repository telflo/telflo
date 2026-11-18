import { randomBytes, randomUUID } from "node:crypto";

// The fake opamp-server's fleet model (D16b Task 1; plan Preflight ruling 4;
// D16a decision 31), for tests only: fake-opamp-server.ts loads the contract,
// checks every request and reply against it, keeps the organizations and the
// publications, and hands this module the 25 operations of the fleet model
// (D16a's, 23 once D16c removed importing; D17b-2 added the token events,
// D17c-1 a new default token), once a request's path ids are
// read and its organization is found
// registered. It never ships (.dockerignore leaves apps/api/src/testing out of
// the images; a lint rule keeps production code from importing it).
//
// Ported from the opamp-server's Go, at 26c6df1 (D16a; the paths are its
// own repository's since D26):
// - management/fleets.go, fleets_request.go,
//   collector_groups.go, enrollment_tokens.go, collectors.go, limits.go and
//   usage.go: each route's check order (the path's ids, the
//   organization, the query or the body, the fleet, the child, then the
//   409s and 422s), its messages and its replies;
// - store/memorydb/memorydb.go and each store's
//   memory.go (fleets, collectorgroups, enrollmenttokens, collectors,
//   publications' Usage): the semantics. A fleet's create
//   (idempotent by id, label and type; fleet_conflict across
//   organizations), its Default group and two tokens; rotation's grace (the
//   old token's expiry the earlier of its own and graceEndsAt, doRefresh set;
//   the current rotate token the newest valid one without doRefresh first);
//   reveal and revoke; collectors.LivenessAt and DriftOf at the injected
//   clock; the list's sorts (names as UTF-8 bytes), q, groupId and cursors
//   that carry their sort and order; the Default group's 409s and a group's
//   delete deleting its collectors and their errors (D17d-1 decision 3); the
//   collector PATCH all or nothing, checked
//   in the order collector, group, pin target, name; the bulk pin's sorted,
//   deduplicated updated and notFound; usage newest first, its
//   groups by fleet then group; and the cascades.
//
// Bearers are random: standard base64 of 134 random bytes (180 characters),
// the shape of the real AES-256-GCM bearer, fresh on each reveal. Nothing
// here decrypts one; the fake has no agent side.
//
// The time is the fake's `now` option, so tests move the clock to put a
// collector on each step of the liveness ladder.
//
// D20 (Task 9) adds the bindings, ported from store/collectorgroups and
// store/collectors at D20 Task 5: a group's variable group and a
// collector's pinned one, each checked the organization's (422
// variable_group_not_found) and stamped with the organization's counter
// when it changes (a collector also on a move between groups whose variable
// groups differ, else carrying the old group's setting's stamp, Ruling 60);
// an assignment or a pin of a published version referencing names no
// variable has refused (422 variables_undefined, with the names); and drift
// by the served published version and the served-variables marker against
// the wanted stamp (DriftOf). The variables themselves are
// fake-opamp-server-variables.ts's.

// ---------------------------------------------------------------------------
// What fake-opamp-server.ts shares with this module.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Reply {
  status: number;
  headers: Record<string, string>;
  /** A JSON value, plain text, or undefined for no body. */
  body: Json | string | undefined;
  isText?: boolean;
}

export function errorReply(status: number, code: string, message: string): Reply {
  return { status, headers: { "content-type": "application/json" }, body: { error: { code, message } } };
}

export const jsonReply = (status: number, body: Json): Reply => ({
  status,
  headers: { "content-type": "application/json" },
  body,
});

export const invalidRequest = (message: string): Reply => errorReply(400, "invalid_request", message);

export const organizationNotFound = (): Reply =>
  errorReply(
    404,
    "organization_not_found",
    "No organization with this id is registered: register it with POST /api/v1/organizations first.",
  );

export const noContent = (): Reply => ({ status: 204, headers: {}, body: undefined });

export function isReply(value: unknown): value is Reply {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "status" in value && "headers" in value;
}

export const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * An RFC 3339 date-time as whole milliseconds since the epoch, truncated
 * (D11a Ruling 27: the server keeps times at milliseconds); NaN for a leap
 * second, which Go's time.Parse refuses. Only for a value the contract's
 * date-time format accepted.
 */
export function toMilliseconds(value: string): number {
  const match = DATE_TIME_PATTERN.exec(value) as RegExpExecArray;
  const fraction = (match[7] ?? ".").slice(1);
  const whole = Date.parse(value.replace(match[7] ?? "", "").toUpperCase());
  return whole + Number(fraction.padEnd(3, "0").slice(0, 3));
}

/**
 * The instants a stored time may be (D11a Ruling 30): from
 * 0001-01-01T00:00:00Z up to, not including, the year 10000. setUTCFullYear
 * for the first, since Date.UTC maps the years 0 to 99 to 1900 to 1999.
 */
export const EARLIEST_INSTANT = (() => {
  const earliest = new Date(0);
  earliest.setUTCFullYear(1, 0, 1);
  return earliest.getTime();
})();
export const AFTER_LATEST_INSTANT = Date.UTC(10000, 0, 1);

export function formatMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

// ---------------------------------------------------------------------------
// The model.

/** A published version, as the fleet model reads it from the fake's publications. */
export interface ModelPublication {
  id: string;
  sha256: string;
  version: { id: string; number: number; label: string | null };
  /** Whole milliseconds. */
  publishedAt: number;
  /** The names its live `${org:NAME}` references name, as Put stored them (D20 decision 30). */
  names: string[];
}

/** What the fleet model reads of the organization's variables (fake-opamp-server-variables.ts's model). */
export interface FleetVariables {
  /** Whether the organization holds the variable group. */
  variableGroupHeld(organizationId: string, variableGroupId: string): boolean;
  /** The names of `names` no variable of the organization has: at most 100 in byte order, and their total. */
  undefinedNames(organizationId: string, names: string[]): { names: string[]; totalNames: number };
  /** Moves the organization's counter on by one and answers its new value. */
  bump(organizationId: string): number;
  /** A defined name's stamp for a collector of those two variable groups (Choose), or undefined for a name no variable has. */
  nameStamp(organizationId: string, name: string, pinnedVariableGroupId: string | null, groupVariableGroupId: string | null): number | undefined;
}

export interface FleetModelOptions {
  now: () => Date;
  /** The organization's publication `id` (lower case), or undefined. */
  publication(organizationId: string, id: string): ModelPublication | undefined;
  /** The organization's publications of the configuration. */
  publicationsOf(organizationId: string, configurationId: string): ModelPublication[];
  /** Whether markPublicationInUse marked the organization's publication: one phantom pinned collector. */
  isMarkedInUse(organizationId: string, id: string): boolean;
  /** The organization's variables (D20). */
  variables: FleetVariables;
}

/** A request for one of the fleet model's operations, its path ids read and its organization registered. */
export interface FleetRequest {
  operationId: string;
  /** Lower case. */
  organizationId: string;
  /** The path's values, as sent. */
  pathValues: Map<string, string>;
  /** The query's documented parameters, each given once, checked against the contract. */
  query: Map<string, string>;
  /** The JSON body, checked as the real server checks it (Content-Type, the 2 MiB cap, JSON, the schema), or the 400 or 413. */
  readBody(): Json | Reply;
  /** The body's text, for what JSON.parse loses (a number's source). */
  bodyText: string;
}

export type ReportedState = {
  collectorVersion?: string | null;
  ip?: string | null;
  hostIp?: string | null;
  attributes?: Record<string, string> | null;
};

export interface EnrollCollectorOptions {
  /** Its name; default a generated one. A taken or invalid name throws. */
  name?: string;
  /**
   * One of the fleet's groups; default its Default group (seeding only: the
   * real agent door refuses a collector naming no group, D17d-1 decision 5,
   * and the fake has no agent door).
   */
  groupId?: string;
  /** One of the fleet's tokens it authenticated with; default the fleet's valid default token (all revoked: its newest). */
  tokenId?: string;
  reported?: ReportedState;
  /** Default now; its enrollment (createdAt) is always now. */
  lastSeenAt?: Date;
}

export interface EnrolledCollector {
  id: string;
  instanceUid: string;
  name: string;
}

export interface CollectorStateChanges {
  /**
   * What it was last served: a published version (sha256 defaults to its,
   * at to now), or `kind: null` for a hash whose published version is
   * gone; null clears it. `variablesStamp` is the served-variables marker
   * the poll records (D20 decision 12): by default, as a poll serving now
   * would, the collector's wanted stamp for a published version, and none
   * for `kind: null`; a number (or null for none) sets it.
   */
  served?:
    | { kind: "publication"; id: string; sha256?: string; at?: Date | null; variablesStamp?: number | null }
    | { kind: null; sha256: string; at?: Date | null; variablesStamp?: number | null }
    | null;
  /** Its last reported status of what it was served (at defaults to now); null clears it. */
  effective?: { sha256: string; status: "applied" | "applying" | "failed"; error?: string | null; at?: Date } | null;
  lastSeenAt?: Date;
  reported?: ReportedState;
}

export interface CollectorErrorReport {
  message: string;
  configSha256?: string | null;
  /** Default now. */
  reportedAt?: Date;
}

/** What a test seeds of a fleet's token history (recordTokenEvents). */
export interface TokenEventSeeding {
  /** How many events: 1 to MAX_SEEDED_EVENTS. */
  count: number;
  /** Their kind; default `viewed`. */
  event?: TokenEventKind;
  /** One of the fleet's tokens; default its valid default token (all revoked: its newest). */
  tokenId?: string;
  /** Who; default null (no person). */
  actor?: { id: string; email: string } | null;
  /** The newest one's time; default now. Each next one a millisecond earlier. */
  occurredAt?: Date;
}

export type TokenEventKind = "issued" | "viewed" | "rotated" | "revoked";

/** The most events one recordTokenEvents seeds. */
export const MAX_SEEDED_EVENTS = 500;

export interface FleetModel {
  /** The operation's answer, or undefined for an operation the model doesn't serve. */
  answer(request: FleetRequest): Reply | undefined;
  /** Whether a group is assigned, or a collector pinned to, the organization's publication (marks aside). */
  publicationUsed(organizationId: string, publicationId: string): boolean;
  /** The groups assigned the organization's publication, and the collectors pinned to it (a mark counting one). */
  publicationUses(organizationId: string, publicationId: string): { groups: { fleetId: string; groupId: string }[]; pinned: number };
  /** The collector groups bound to the organization's variable group, and the collectors it is pinned on. */
  variableGroupUses(organizationId: string, variableGroupId: string): { groups: { fleetId: string; groupId: string }[]; pinned: number };
  /** A publication was deleted: each collector served it keeps the hash and loses the pointer. */
  publicationDeleted(organizationId: string, publicationId: string): void;
  /** The organization's delete: everything of the fleet model it held goes. */
  deleteOrganization(organizationId: string): void;
  enrollCollector(organizationId: string, fleetId: string, options?: EnrollCollectorOptions): EnrolledCollector;
  setCollectorState(organizationId: string, collectorId: string, changes: CollectorStateChanges): void;
  recordCollectorError(organizationId: string, collectorId: string, report: CollectorErrorReport): { id: string };
  /** Seeds the fleet's token history with `count` events (the history's paging), newest first from occurredAt. */
  recordTokenEvents(organizationId: string, fleetId: string, seeding: TokenEventSeeding): { count: number };
  /** A deep copy of what the organization holds in the fleet model, each list sorted by id. */
  snapshotOf(organizationId: string): Record<string, unknown>;
}

// The stored rows, each time in whole milliseconds.

interface Actor {
  id: string;
  email: string;
}

type FleetType = "server" | "kubernetes-supervisor";
type FleetStatus = "active" | "archived";

interface StoredFleet {
  id: string;
  organizationId: string;
  label: string;
  type: FleetType;
  status: FleetStatus;
  createdBy: Actor | null;
  createdAt: number;
  updatedAt: number;
}

interface StoredGroup {
  id: string;
  organizationId: string;
  fleetId: string;
  name: string;
  isDefault: boolean;
  assignedPublicationId: string | null;
  /** The client's own data (D17c-1 decision 30), in its canonical form (keys sorted), or null. */
  annotations: JsonObject | null;
  /** D20: the variable group its collectors use, or null, and its setting's stamp (null until first set). */
  variableGroupId: string | null;
  variableGroupStamp: number | null;
  createdAt: number;
  updatedAt: number;
}

interface StoredToken {
  id: string;
  organizationId: string;
  fleetId: string;
  kind: "default" | "rotate";
  expiresAt: number | null;
  revokedAt: number | null;
  doRefresh: boolean;
  createdBy: Actor | null;
  createdAt: number;
}

/** A pin or a served pointer: a published version, the one kind since D16c. */
interface Ref {
  kind: "publication";
  id: string;
}

interface StoredCollector {
  id: string;
  organizationId: string;
  fleetId: string;
  groupId: string;
  instanceUid: string;
  name: string;
  pinned: Ref | null;
  /** D20: a variable group pinned on it, or null; the stamp of its pin's setting or of a move (null until first stamped). */
  pinnedVariableGroupId: string | null;
  pinnedVariableGroupStamp: number | null;
  /** ref null once the published version it names is deleted (the hash stays). */
  served: { ref: Ref | null; sha256: string; at: number | null } | null;
  /** D20: the served-variables marker, the newest stamp it was served with, or null for none (0). */
  servedVariablesStamp: number | null;
  effective: { sha256: string; status: "applied" | "applying" | "failed"; error: string | null; at: number } | null;
  reported: {
    collectorVersion: string | null;
    ip: string | null;
    hostIp: string | null;
    attributes: Record<string, string> | null;
  };
  enrollmentTokenId: string | null;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

/** A token event (enrollment_token_events): ids, the actor and the time, never a bearer. */
interface StoredTokenEvent {
  id: string;
  organizationId: string;
  fleetId: string;
  tokenId: string;
  event: TokenEventKind;
  actor: Actor | null;
  occurredAt: number;
}

interface StoredError {
  id: string;
  organizationId: string;
  collectorId: string;
  reportedAt: number;
  configSha256: string | null;
  message: string;
}

interface StoredLimits {
  maxCollectors: number | null;
  requestsPerMinute: number | null;
}

// The bounds and the ladder (store/collectors/collectors.go, store/enrollmenttokens).
const DEFAULT_LIST_LIMIT = 50;
const ONLINE_WITHIN_MS = 60_000;
const WARNING_WITHIN_MS = 120_000;
const UNKNOWN_WITHIN_MS = 300_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_ERRORS = 100;
const MAX_ANNOTATIONS_BYTES = 16_384;
const MAX_MESSAGE_BYTES = 8192;
const MAX_ATTRIBUTES_BYTES = 16_384;
/** handlers/report.go's maxStoredAttributes: the names a bounded description keeps at most. */
const MAX_STORED_ATTRIBUTES = 256;
const MAX_COLLECTOR_VERSION_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 100;
/** handlers/report.go's emptyFailureMessage: what a failed report without a message records. */
const EMPTY_FAILURE_MESSAGE = "The collector reported a failure without a message.";
/** The bytes a real bearer has before base64: a 12-byte nonce, the claims' ciphertext and the tag. */
const BEARER_BYTES = 134;

// The fixed messages (management/*.go). None quotes a value.
const MESSAGE_FLEET_NOT_FOUND = "The organization has no fleet with this id.";
const MESSAGE_FLEET_CONFLICT = "A different fleet already has this id.";
const MESSAGE_FLEET_LABEL_TAKEN = "Another of the organization's fleets has this label.";
const MESSAGE_FLEET_ARCHIVED = "The fleet is archived.";
const MESSAGE_GROUP_NOT_FOUND = "The fleet has no collector group with this id.";
const MESSAGE_GROUP_NAME_TAKEN = "Another of the fleet's collector groups has this name.";
const MESSAGE_GROUP_IS_DEFAULT = "The fleet's Default group can't be renamed or deleted.";
const MESSAGE_PUBLICATION_NOT_FOUND = "The organization holds no published version with this id.";
const MESSAGE_ANNOTATIONS = "annotations must be a JSON object of at most 16384 bytes, or null.";
const MESSAGE_TOKEN_NOT_FOUND = "The fleet has no enrollment token with this id.";
const MESSAGE_TOKEN_REVOKED = "The enrollment token is revoked.";
const MESSAGE_TOKEN_EXPIRED = "The enrollment token has expired.";
const MESSAGE_DEFAULT_TOKEN_EXISTS = "The fleet already has a valid default token.";
const MESSAGE_COLLECTOR_NOT_FOUND = "The fleet has no collector with this id.";
const MESSAGE_COLLECTOR_NAME_TAKEN = "Another of the organization's collectors has this name.";
const MESSAGE_CURSOR = "cursor isn't one this API gave.";
// D20 (management/variables.go).
const MESSAGE_VARIABLE_GROUP_NOT_FOUND = "The organization holds no variable group with this id.";
const MESSAGE_VARIABLES_UNDEFINED = "The published version references organization variables that aren't defined.";

const fleetNotFound = (): Reply => errorReply(404, "fleet_not_found", MESSAGE_FLEET_NOT_FOUND);

/** The bearer reply's header (Ruling 35). */
const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

/** A name, label or group name: the contract's pattern (Go's unicode.IsSpace at the ends, no unicode.IsControl). */
const NAME_PATTERN =
  // eslint-disable-next-line no-control-regex -- the contract's own pattern refuses control characters
  /^[^\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]([^\x00-\x1f\x7f-\x9f]*[^\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])?$/u;

function validName(name: string, maxCharacters: number): boolean {
  const characters = [...name].length;
  return characters >= 1 && characters <= maxCharacters && NAME_PATTERN.test(name);
}

/** Compares as Postgres's `collate "C"` and Go's strings.Compare do: by UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Ids in their canonical lower case compare as Postgres compares uuids: by bytes. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newBearer(): string {
  return randomBytes(BEARER_BYTES).toString("base64");
}

function formatOptional(milliseconds: number | null): string | null {
  return milliseconds === null ? null : formatMilliseconds(milliseconds);
}

export function actorJson(actor: Actor | null): Json {
  return actor === null ? null : { id: actor.id, email: actor.email };
}

export function decodeActor(value: Json | undefined): Actor | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return { id: String(value.id).toLowerCase(), email: String(value.email) };
}

/** A body's date-time field as the server reads it: a 400 for a leap second or a year outside 0001 to 9999. */
function readInstant(field: string, value: string): number | Reply {
  const milliseconds = toMilliseconds(value);
  if (Number.isNaN(milliseconds)) return invalidRequest(`${field} must be an RFC 3339 date-time.`);
  if (milliseconds < EARLIEST_INSTANT || milliseconds >= AFTER_LATEST_INSTANT) {
    return invalidRequest(`${field} must be from the year 0001 to 9999, in UTC.`);
  }
  return milliseconds;
}

// Cursors, as the stores encode them: unpadded base64url.

function idBytes(id: string): Buffer {
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

function idOf(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function instantBytes(milliseconds: number): Buffer {
  const raw = Buffer.alloc(8);
  raw.writeBigInt64BE(BigInt(milliseconds) * 1000n);
  return raw;
}

/** 8 bytes of microseconds, or undefined for what no stored time can be. */
function readInstantBytes(raw: Buffer): number | undefined {
  const micros = raw.readBigInt64BE(0);
  if (micros % 1000n !== 0n) return undefined;
  const milliseconds = Number(micros / 1000n);
  if (milliseconds < EARLIEST_INSTANT || milliseconds >= AFTER_LATEST_INSTANT) return undefined;
  return milliseconds;
}

/** The raw bytes of a cursor this fake gave, or undefined (Go's RawURLEncoding.Strict()). */
function cursorBytes(cursor: string): Buffer | undefined {
  const raw = Buffer.from(cursor, "base64url");
  return raw.toString("base64url") === cursor ? raw : undefined;
}

/** A fleet's or an error's cursor: the instant (8 bytes) and the id. */
interface TimeCursor {
  at: number;
  id: string;
}

function encodeTimeCursor(at: number, id: string): string {
  return Buffer.concat([instantBytes(at), idBytes(id)]).toString("base64url");
}

function decodeTimeCursor(cursor: string): TimeCursor | undefined {
  const raw = cursorBytes(cursor);
  if (raw === undefined || raw.length !== 24) return undefined;
  const at = readInstantBytes(raw.subarray(0, 8));
  return at === undefined ? undefined : { at, id: idOf(raw.subarray(8)) };
}

/** Newest first: the instant, then the id, both descending. */
function newestFirst(a: TimeCursor, b: TimeCursor): number {
  return a.at !== b.at ? b.at - a.at : compareIds(b.id, a.id);
}

const SORTS = ["created", "lastSeen", "name"] as const;
const ORDERS = ["asc", "desc"] as const;
type Sort = (typeof SORTS)[number];
type Order = (typeof ORDERS)[number];

interface CollectorCursor {
  sort: Sort;
  order: Order;
  at: number;
  name: string;
  id: string;
}

const COLLECTOR_CURSOR_VERSION = 1;

function encodeCollectorCursor(c: StoredCollector, sort: Sort, order: Order): string {
  const key =
    sort === "name"
      ? Buffer.from(c.name, "utf8")
      : instantBytes(sort === "created" ? c.createdAt : c.lastSeenAt);
  return Buffer.concat([
    Buffer.from([COLLECTOR_CURSOR_VERSION, SORTS.indexOf(sort), ORDERS.indexOf(order)]),
    key,
    idBytes(c.id),
  ]).toString("base64url");
}

function decodeCollectorCursor(cursor: string): CollectorCursor | undefined {
  const raw = cursorBytes(cursor);
  if (raw === undefined || raw.length < 3 + 16 || raw[0] !== COLLECTOR_CURSOR_VERSION) return undefined;
  const sort = SORTS[raw[1] as number];
  const order = ORDERS[raw[2] as number];
  if (sort === undefined || order === undefined) return undefined;
  const key = raw.subarray(3, raw.length - 16);
  const id = idOf(raw.subarray(raw.length - 16));
  if (sort === "name") {
    const name = key.toString("utf8");
    // Valid UTF-8 (it decodes back to the same bytes) and a valid name.
    if (!Buffer.from(name, "utf8").equals(key) || !validName(name, 200)) return undefined;
    return { sort, order, at: 0, name, id };
  }
  if (key.length !== 8) return undefined;
  const at = readInstantBytes(key);
  return at === undefined ? undefined : { sort, order, at, name: "", id };
}

/** a before b in the sort and order: the key, then the id, both in the order's direction. */
function compareListed(
  a: { createdAt: number; lastSeenAt: number; name: string; id: string },
  b: { createdAt: number; lastSeenAt: number; name: string; id: string },
  sort: Sort,
  order: Order,
): number {
  let c =
    sort === "created"
      ? Math.sign(a.createdAt - b.createdAt)
      : sort === "lastSeen"
        ? Math.sign(a.lastSeenAt - b.lastSeenAt)
        : compareBytes(a.name, b.name);
  if (c === 0) c = compareIds(a.id, b.id);
  return order === "desc" ? -c : c;
}

/** The page of `sorted` (already past any cursor) and the next cursor, as the stores page. */
function pageOf<T>(sorted: T[], limit: number, cursorOf: (last: T) => string): { page: T[]; next: string | null } {
  const page = sorted.slice(0, limit);
  const last = page.at(-1);
  return { page, next: sorted.length > limit && last !== undefined ? cursorOf(last) : null };
}

function listLimit(query: Map<string, string>): number {
  const raw = query.get("limit");
  return raw === undefined ? DEFAULT_LIST_LIMIT : Number(raw);
}

/** The liveness ladder (collectors.LivenessAt): each step's lower edge included; a last seen ahead of now is online. */
function livenessAt(lastSeen: number, now: number): string {
  const age = now - lastSeen;
  if (age < ONLINE_WITHIN_MS) return "online";
  if (age < WARNING_WITHIN_MS) return "warning";
  if (age < UNKNOWN_WITHIN_MS) return "unknown";
  return "offline";
}

interface Resolution {
  from: "pinnedPublication" | "groupPublication";
  id: string;
  sha256: string;
  /** D20: the marker the collector must have been served at least (WantedStamp). */
  wanted: number;
}

/**
 * collectors.DriftOf (D20 decisions 12 and 34): Pending when it was never
 * served, or served another published version than the resolved one, or
 * its served-variables marker is below the wanted stamp, or it hasn't
 * reported since; then Failed, or applied: InSync on the served hash (the
 * filled-in bytes'), else Drifted. The served hash is never compared with
 * the published version's own.
 */
function driftOf(resolved: Resolution | undefined, c: StoredCollector): string {
  const { served, effective } = c;
  if (resolved === undefined) return "unassigned";
  if (
    served === null ||
    served.ref?.id !== resolved.id ||
    (c.servedVariablesStamp ?? 0) < resolved.wanted ||
    served.at === null ||
    effective === null ||
    effective.at < served.at
  ) {
    return "pending";
  }
  if (effective.status === "failed") return "failed";
  if (effective.status === "applied") return effective.sha256 === served.sha256 ? "inSync" : "drifted";
  return "pending";
}

/** A number of a request body, as its text was written (Go's json.Number, decoded with UseNumber). */
class NumberText {
  constructor(readonly text: string) {}
}

/** A JSON value whose numbers are kept as written. */
type WrittenJson = null | boolean | NumberText | string | WrittenJson[] | { [key: string]: WrittenJson };

/**
 * A group body's annotations, each number kept as its text was written: the
 * body re-read with each number's source (JSON.parse's source text access).
 * Undefined when the body has none.
 */
function fieldAsWritten(bodyText: string, field: "annotations"): WrittenJson | undefined {
  const root = JSON.parse(bodyText, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? new NumberText(context.source) : value,
  ) as Partial<Record<typeof field, WrittenJson>>;
  return root[field];
}

/**
 * Whether jsonb stores the annotations as written (collectorgroups'
 * jsonbKeepsAsWritten): no number with an exponent and no negative zero,
 * which numeric rewrites, and no U+0000 in a string or a key, which jsonb
 * refuses.
 */
function keepsAsWritten(value: WrittenJson): boolean {
  if (value instanceof NumberText) return !/[eE]/.test(value.text) && !/^-[0.]*$/.test(value.text);
  if (typeof value === "string") return !value.includes("\u0000");
  if (Array.isArray(value)) return value.every(keepsAsWritten);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, item]) => !key.includes("\u0000") && keepsAsWritten(item));
  }
  return true;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(`(?:${LONE_SURROGATE.source})+`, "g");

/**
 * A string as Go's encoder writes it with SetEscapeHTML(false)
 * (encoding/json's appendString): `"` and `\` and \b, \f, \n, \r, \t
 * escaped short, any other C0 control as \u00XX, U+2028 and U+2029 as
 * \u2028 and \u2029, the rest as UTF-8. A lone surrogate is U+FFFD, as Go's
 * decoder reads an escaped one.
 */
function goJsonString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\b") out += "\\b";
    else if (character === "\f") out += "\\f";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u00${code.toString(16).padStart(2, "0")}`;
    else if (code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16)}`;
    else if (LONE_SURROGATE.test(character)) out += "\ufffd";
    else out += character;
  }
  return `${out}"`;
}

/**
 * The canonical text CanonicalAnnotations writes: Go's encoder over the value
 * decoded with UseNumber, so each number as written, each object's keys
 * sorted by bytes, no spaces.
 */
function goCanonicalText(value: WrittenJson): string {
  if (value instanceof NumberText) return value.text;
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return goJsonString(value);
  if (Array.isArray(value)) return `[${value.map(goCanonicalText).join(",")}]`;
  const keys = Object.keys(value).sort(compareBytes);
  return `{${keys.map((key) => `${goJsonString(key)}:${goCanonicalText(value[key] as WrittenJson)}`).join(",")}}`;
}

/** The value with every object's keys sorted as Go's encoder sorts a map's (by bytes). */
function sortedKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort(compareBytes);
  return Object.fromEntries(keys.map((key) => [key, sortedKeys(value[key] as Json)]));
}

/**
 * The canonical annotations (CanonicalAnnotations, D17c-1 decision 30), or
 * undefined when the server refuses them (400): an object jsonb keeps as
 * written, whose canonical text (each number as written) is at most 16384
 * bytes; stored and answered with every object's keys sorted. The fake
 * stores and answers the parsed value (a number's text as JSON.stringify
 * writes it: 1.50 answers 1.5), since its replies are plain JSON values
 * checked by ajv. Like the memory store, the fake doesn't count Postgres's
 * jsonb text (its table's check).
 */
function canonicalAnnotations(value: Json, asWritten: WrittenJson | undefined): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || asWritten === undefined || !keepsAsWritten(asWritten)) {
    return undefined;
  }
  return Buffer.byteLength(goCanonicalText(asWritten), "utf8") > MAX_ANNOTATIONS_BYTES ? undefined : (sortedKeys(value) as JsonObject);
}

// The agent side's bounds (store/collectors/collectors.go, handlers/report.go).

/** Go's unicode.IsSpace, which strings.TrimSpace trims. */
const GO_SPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, "gu");

/** fleets.ValidText: valid UTF-8 (no lone surrogate), no NUL, min to max characters. */
function validText(value: string, min: number, max: number): boolean {
  const characters = [...value].length;
  return !LONE_SURROGATE.test(value) && !value.includes("\u0000") && characters >= min && characters <= max;
}

/**
 * collectors.BoundMessage: invalid UTF-8 (a run of lone surrogates, as Go's
 * strings.ToValidUTF8 replaces a run of invalid bytes) and each NUL
 * replaced with U+FFFD, then cut to at most 8192 UTF-8 bytes on a
 * character's boundary.
 */
function boundMessage(message: string): string {
  const valid = message.replace(LONE_SURROGATES, "\ufffd").replaceAll("\u0000", "\ufffd");
  const bytes = Buffer.from(valid, "utf8");
  if (bytes.length <= MAX_MESSAGE_BYTES) return valid;
  let cut = MAX_MESSAGE_BYTES;
  while (cut > 0 && ((bytes[cut] as number) & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString("utf8");
}

/** jsonbStringLength: a string's bytes as jsonb writes it out, its quotes and each byte escaped as escape_json does. */
function jsonbStringLength(value: string): number {
  let n = 2;
  for (const byte of Buffer.from(value, "utf8")) {
    if (byte === 0x22 || byte === 0x5c || byte === 0x08 || byte === 0x0c || byte === 0x0a || byte === 0x0d || byte === 0x09) n += 2;
    else if (byte < 0x20) n += 6;
    else n += 1;
  }
  return n;
}

/** collectors.ValidAttributes: no lone surrogate and no NUL, within 16384 bytes as jsonb writes them out (`{"k": "v", ...}`). */
function validAttributes(attributes: Record<string, string>): boolean {
  const pairs = Object.entries(attributes);
  if (pairs.some(([key, value]) => [key, value].some((s) => LONE_SURROGATE.test(s) || s.includes("\u0000")))) return false;
  if (pairs.length === 0) return true;
  let length = 2 + 2 * (pairs.length - 1);
  for (const [key, value] of pairs) length += jsonbStringLength(key) + 2 + jsonbStringLength(value);
  return length <= MAX_ATTRIBUTES_BYTES;
}

/**
 * handlers' boundedAttributes: all of them when the store takes them, else
 * the names sorted by bytes, the first 256, each kept while the whole stays
 * valid.
 */
function boundedAttributes(attributes: Record<string, string>): Record<string, string> {
  if (validAttributes(attributes)) return { ...attributes };
  const out: Record<string, string> = {};
  for (const key of Object.keys(attributes).sort(compareBytes).slice(0, MAX_STORED_ATTRIBUTES)) {
    out[key] = attributes[key] as string;
    if (!validAttributes(out)) delete out[key];
  }
  return out;
}

function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Starts a fleet model; fake-opamp-server.ts owns one. */
export function createFleetModel(options: FleetModelOptions): FleetModel {
  const fleets = new Map<string, StoredFleet>();
  const groups = new Map<string, StoredGroup>();
  const tokens = new Map<string, StoredToken>();
  const collectors = new Map<string, StoredCollector>();
  const collectorErrors = new Map<string, StoredError>();
  const tokenEvents = new Map<string, StoredTokenEvent>();
  const limits = new Map<string, StoredLimits>();
  let petnames = 0;

  const nowMs = () => options.now().getTime();

  const fleetOf = (organizationId: string, id: string) => {
    const f = fleets.get(id);
    return f !== undefined && f.organizationId === organizationId ? f : undefined;
  };
  const groupOf = (organizationId: string, fleetId: string, id: string) => {
    const g = groups.get(id);
    return g !== undefined && g.organizationId === organizationId && g.fleetId === fleetId ? g : undefined;
  };
  const tokenOf = (organizationId: string, fleetId: string, id: string) => {
    const t = tokens.get(id);
    return t !== undefined && t.organizationId === organizationId && t.fleetId === fleetId ? t : undefined;
  };
  const collectorOf = (organizationId: string, fleetId: string, id: string) => {
    const c = collectors.get(id);
    return c !== undefined && c.organizationId === organizationId && c.fleetId === fleetId ? c : undefined;
  };
  const defaultGroupOf = (organizationId: string, fleetId: string) =>
    [...groups.values()].find((g) => g.organizationId === organizationId && g.fleetId === fleetId && g.isDefault);
  const nameTaken = (organizationId: string, name: string, except: string) =>
    [...collectors.values()].some((c) => c.id !== except && c.organizationId === organizationId && c.name === name);

  /** notFoundOrFleetNotFound: the child's 404, or fleet_not_found when the fleet itself isn't the organization's. */
  function childNotFound(request: FleetRequest, fleetId: string, code: string, message: string): Reply {
    return fleetOf(request.organizationId, fleetId) === undefined ? fleetNotFound() : errorReply(404, code, message);
  }

  /**
   * What resolves for c: its pin, else its group's assigned published
   * version, else nothing (collectors' resolve), with its wanted stamp
   * (resolveWanted): 0 when the published version names nothing; else the
   * greatest of each name's stamp (Choose from the pin's variable group, the
   * group's and the variable; 0 for a name no variable has) and the two
   * settings' stamps.
   */
  function resolve(c: StoredCollector): Resolution | undefined {
    const group = groupOf(c.organizationId, c.fleetId, c.groupId);
    let from: Resolution["from"];
    let p: ModelPublication | undefined;
    if (c.pinned?.kind === "publication") {
      from = "pinnedPublication";
      p = options.publication(c.organizationId, c.pinned.id);
    } else {
      from = "groupPublication";
      const assigned = group?.assignedPublicationId;
      p = assigned === null || assigned === undefined ? undefined : options.publication(c.organizationId, assigned);
    }
    if (p === undefined) return undefined;
    let wanted = 0;
    if (p.names.length > 0) {
      const groupVariableGroup = group?.variableGroupId ?? null;
      wanted = Math.max(group?.variableGroupStamp ?? 0, c.pinnedVariableGroupStamp ?? 0);
      for (const name of p.names) {
        wanted = Math.max(wanted, options.variables.nameStamp(c.organizationId, name, c.pinnedVariableGroupId, groupVariableGroup) ?? 0);
      }
    }
    return { from, id: p.id, sha256: p.sha256, wanted };
  }

  /** refExists: 422 for a published version the organization doesn't hold. */
  function pinTargetMissing(organizationId: string, ref: Ref | null): Reply | undefined {
    if (ref === null) return undefined;
    return options.publication(organizationId, ref.id) === undefined
      ? errorReply(422, "publication_not_found", MESSAGE_PUBLICATION_NOT_FOUND)
      : undefined;
  }

  /** checkVariableGroup: 422 for a variable group the organization doesn't hold; nothing to check for none. */
  function variableGroupMissing(organizationId: string, variableGroupId: string | null): Reply | undefined {
    if (variableGroupId === null || options.variables.variableGroupHeld(organizationId, variableGroupId)) return undefined;
    return errorReply(422, "variable_group_not_found", MESSAGE_VARIABLE_GROUP_NOT_FOUND);
  }

  /**
   * checkDefined (D20 decision 7): 422 variables_undefined, with the names,
   * for a published version referencing names no variable of the
   * organization has; nothing to check for an unpin.
   */
  function undefinedRefused(organizationId: string, publicationId: string | null): Reply | undefined {
    if (publicationId === null) return undefined;
    const names = options.publication(organizationId, publicationId)?.names ?? [];
    const undefinedNames = options.variables.undefinedNames(organizationId, names);
    if (undefinedNames.totalNames === 0) return undefined;
    const reply = errorReply(422, "variables_undefined", MESSAGE_VARIABLES_UNDEFINED);
    ((reply.body as JsonObject).error as JsonObject).details = { names: undefinedNames.names, totalNames: undefinedNames.totalNames };
    return reply;
  }

  /**
   * stampsCollector: a collector's pinned variable group changing, or a
   * move between groups whose variable groups differ, is stamped with the
   * counter's next value; else a move carries the old group's setting's
   * stamp (carriedStamp, Ruling 60). Called after every check.
   */
  function restamp(c: StoredCollector, nextGroupId: string, nextPinned: string | null): void {
    const current = groupOf(c.organizationId, c.fleetId, c.groupId);
    const next = groupOf(c.organizationId, c.fleetId, nextGroupId);
    const moved = nextGroupId !== c.groupId;
    if (c.pinnedVariableGroupId !== nextPinned || (moved && (current?.variableGroupId ?? null) !== (next?.variableGroupId ?? null))) {
      c.pinnedVariableGroupStamp = options.variables.bump(c.organizationId);
    } else if (moved) {
      const oldGroupStamp = current?.variableGroupStamp ?? null;
      if (c.pinnedVariableGroupStamp !== null || oldGroupStamp !== null) {
        c.pinnedVariableGroupStamp = Math.max(c.pinnedVariableGroupStamp ?? 0, oldGroupStamp ?? 0);
      }
    }
  }

  function summaryOf(fleet: StoredFleet, now: number): JsonObject {
    const summary = {
      collectors: 0,
      online: 0,
      warning: 0,
      unknown: 0,
      offline: 0,
      inSync: 0,
      pending: 0,
      failed: 0,
      drifted: 0,
      unassigned: 0,
    };
    let lastSeenAt: number | null = null;
    for (const c of collectors.values()) {
      if (c.organizationId !== fleet.organizationId || c.fleetId !== fleet.id) continue;
      summary.collectors++;
      summary[livenessAt(c.lastSeenAt, now) as "online"]++;
      summary[driftOf(resolve(c), c) as "inSync"]++;
      if (lastSeenAt === null || c.lastSeenAt > lastSeenAt) lastSeenAt = c.lastSeenAt;
    }
    return { ...summary, lastSeenAt: formatOptional(lastSeenAt), rotateToken: rotateTokenOf(fleet, now) };
  }

  /**
   * RotateStates (D17a Preflight ruling 2): null without a valid rotate
   * token; else the current one's expiry, the latest expiry among the other
   * valid tokens in their grace, and how many are valid.
   */
  function rotateTokenOf(fleet: StoredFleet, now: number): JsonObject | null {
    const current = currentRotate(fleet.organizationId, fleet.id, now);
    if (current === undefined) return null;
    let validCount = 0;
    let graceEndsAt: number | null = null;
    for (const t of tokens.values()) {
      if (t.organizationId !== fleet.organizationId || t.fleetId !== fleet.id || t.kind !== "rotate" || !validAt(t, now)) continue;
      validCount++;
      if (t.doRefresh && t.id !== current.id && t.expiresAt !== null && (graceEndsAt === null || t.expiresAt > graceEndsAt)) {
        graceEndsAt = t.expiresAt;
      }
    }
    return { expiresAt: formatOptional(current.expiresAt), graceEndsAt: formatOptional(graceEndsAt), validCount };
  }

  function fleetJson(f: StoredFleet): JsonObject {
    return {
      id: f.id,
      organizationId: f.organizationId,
      label: f.label,
      type: f.type,
      status: f.status,
      createdBy: actorJson(f.createdBy),
      createdAt: formatMilliseconds(f.createdAt),
      updatedAt: formatMilliseconds(f.updatedAt),
    };
  }

  const fleetDetailJson = (f: StoredFleet, now: number): JsonObject => ({ ...fleetJson(f), summary: summaryOf(f, now) });

  function groupJson(g: StoredGroup): JsonObject {
    return {
      id: g.id,
      fleetId: g.fleetId,
      name: g.name,
      isDefault: g.isDefault,
      assignedPublicationId: g.assignedPublicationId,
      annotations: g.annotations === null ? null : (structuredClone(g.annotations) as JsonObject),
      variableGroupId: g.variableGroupId,
      createdAt: formatMilliseconds(g.createdAt),
      updatedAt: formatMilliseconds(g.updatedAt),
    };
  }

  /** An event of the token's (store/enrollmenttokens' insertEvent): the actor copied, as the row's snapshot of it. */
  function addEvent(token: StoredToken, event: TokenEventKind, actor: Actor | null, occurredAt: number): void {
    const id = randomUUID();
    tokenEvents.set(id, {
      id,
      organizationId: token.organizationId,
      fleetId: token.fleetId,
      tokenId: token.id,
      event,
      actor: actor === null ? null : { ...actor },
      occurredAt,
    });
  }

  function tokenJson(t: StoredToken): JsonObject {
    return {
      id: t.id,
      fleetId: t.fleetId,
      kind: t.kind,
      expiresAt: formatOptional(t.expiresAt),
      revokedAt: formatOptional(t.revokedAt),
      doRefresh: t.doRefresh,
      createdBy: actorJson(t.createdBy),
      createdAt: formatMilliseconds(t.createdAt),
    };
  }

  const validAt = (t: StoredToken, now: number) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);

  function collectorJson(c: StoredCollector, now: number): JsonObject {
    const resolved = resolve(c);
    return {
      id: c.id,
      instanceUid: c.instanceUid,
      name: c.name,
      fleetId: c.fleetId,
      groupId: c.groupId,
      pin: c.pinned === null ? null : { kind: c.pinned.kind, id: c.pinned.id },
      pinnedVariableGroupId: c.pinnedVariableGroupId,
      resolution: resolved === undefined ? null : { from: resolved.from, id: resolved.id, sha256: resolved.sha256 },
      served:
        c.served === null
          ? null
          : {
              kind: c.served.ref?.kind ?? null,
              id: c.served.ref?.id ?? null,
              sha256: c.served.sha256,
              at: formatOptional(c.served.at),
            },
      effective:
        c.effective === null
          ? null
          : {
              sha256: c.effective.sha256,
              status: c.effective.status,
              error: c.effective.error,
              at: formatMilliseconds(c.effective.at),
            },
      reported: {
        collectorVersion: c.reported.collectorVersion,
        ip: c.reported.ip,
        hostIp: c.reported.hostIp,
        attributes: c.reported.attributes === null ? null : { ...c.reported.attributes },
      },
      enrollmentTokenId: c.enrollmentTokenId,
      lastSeenAt: formatMilliseconds(c.lastSeenAt),
      liveness: livenessAt(c.lastSeenAt, now),
      sync: driftOf(resolved, c),
      createdAt: formatMilliseconds(c.createdAt),
      updatedAt: formatMilliseconds(c.updatedAt),
    };
  }

  /** The body, or the reply refusing it. */
  function bodyOf(request: FleetRequest): JsonObject | Reply {
    const body = request.readBody();
    return isReply(body) ? body : (body as JsonObject);
  }

  // -------------------------------------------------------------------------
  // Fleets (management/fleets.go; store/fleets/memory.go).

  function createFleet(request: FleetRequest): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const now = nowMs();
    const label = body.label as string;
    const type = body.type as FleetType;
    let rotateExpiresAt: number | null = null;
    if (body.rotateExpiresAt !== null && body.rotateExpiresAt !== undefined) {
      const at = readInstant("rotateExpiresAt", body.rotateExpiresAt as string);
      if (typeof at !== "number") return at;
      if (at <= now) return invalidRequest("rotateExpiresAt must be in the future, or null.");
      rotateExpiresAt = at;
    }
    const actor = decodeActor(body.actor);
    const organizationId = request.organizationId;
    // Without an id the server makes one, so such a POST can't be safely retried.
    const id = typeof body.id === "string" ? body.id.toLowerCase() : randomUUID();

    // In the store's order: this organization's fleet with the id, the label,
    // then another organization's fleet with the id.
    const existing = fleetOf(organizationId, id);
    if (existing !== undefined) {
      if (existing.label === label && existing.type === type) return jsonReply(200, { fleet: fleetJson(existing) });
      return errorReply(409, "fleet_conflict", MESSAGE_FLEET_CONFLICT);
    }
    if ([...fleets.values()].some((f) => f.organizationId === organizationId && f.label === label)) {
      return errorReply(409, "fleet_label_taken", MESSAGE_FLEET_LABEL_TAKEN);
    }
    if (fleets.has(id)) return errorReply(409, "fleet_conflict", MESSAGE_FLEET_CONFLICT);

    const fleet: StoredFleet = {
      id,
      organizationId,
      label,
      type,
      status: "active",
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    const defaultGroup: StoredGroup = {
      id: randomUUID(),
      organizationId,
      fleetId: id,
      name: "Default",
      isDefault: true,
      assignedPublicationId: null,
      annotations: null,
      variableGroupId: null,
      variableGroupStamp: null,
      createdAt: now,
      updatedAt: now,
    };
    const token = (kind: "default" | "rotate", expiresAt: number | null): StoredToken => ({
      id: randomUUID(),
      organizationId,
      fleetId: id,
      kind,
      expiresAt,
      revokedAt: null,
      doRefresh: false,
      createdBy: actor === null ? null : { ...actor },
      createdAt: now,
    });
    const defaultToken = token("default", null);
    const rotateToken = token("rotate", rotateExpiresAt);
    fleets.set(id, fleet);
    groups.set(defaultGroup.id, defaultGroup);
    tokens.set(defaultToken.id, defaultToken);
    tokens.set(rotateToken.id, rotateToken);
    addEvent(defaultToken, "issued", actor, now);
    addEvent(rotateToken, "issued", actor, now);
    return {
      status: 201,
      headers: { ...NO_STORE },
      body: {
        fleet: fleetJson(fleet),
        defaultGroup: groupJson(defaultGroup),
        tokens: {
          default: { id: defaultToken.id, bearer: newBearer() },
          rotate: { id: rotateToken.id, bearer: newBearer(), expiresAt: formatOptional(rotateExpiresAt) },
        },
      },
    };
  }

  function listFleets(request: FleetRequest): Reply {
    const { query, organizationId } = request;
    const rawCursor = query.get("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeTimeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === undefined) return invalidRequest(MESSAGE_CURSOR);
    const status = query.get("status");
    const now = nowMs();
    const matching = [...fleets.values()]
      .filter((f) => f.organizationId === organizationId && (status === undefined || f.status === status))
      .filter((f) => cursor === undefined || newestFirst(cursor, { at: f.createdAt, id: f.id }) < 0)
      .sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }));
    const { page, next } = pageOf(matching, listLimit(query), (last) => encodeTimeCursor(last.createdAt, last.id));
    return jsonReply(200, { fleets: page.map((f) => fleetDetailJson(f, now)), nextCursor: next });
  }

  function getFleet(request: FleetRequest, fleetId: string): Reply {
    const fleet = fleetOf(request.organizationId, fleetId);
    return fleet === undefined ? fleetNotFound() : jsonReply(200, fleetDetailJson(fleet, nowMs()));
  }

  function updateFleet(request: FleetRequest, fleetId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const fleet = fleetOf(request.organizationId, fleetId);
    if (fleet === undefined) return fleetNotFound();
    const label = (body.label as string | undefined) ?? fleet.label;
    const status = (body.status as FleetStatus | undefined) ?? fleet.status;
    if (
      label !== fleet.label &&
      [...fleets.values()].some((f) => f.id !== fleetId && f.organizationId === request.organizationId && f.label === label)
    ) {
      return errorReply(409, "fleet_label_taken", MESSAGE_FLEET_LABEL_TAKEN);
    }
    if (label !== fleet.label || status !== fleet.status) {
      fleet.label = label;
      fleet.status = status;
      fleet.updatedAt = nowMs();
    }
    return jsonReply(200, fleetJson(fleet));
  }

  /** memorydb's DeleteFleet: its groups, tokens, collectors and their errors go with it. */
  function removeFleet(fleetId: string): void {
    fleets.delete(fleetId);
    for (const [id, g] of groups) if (g.fleetId === fleetId) groups.delete(id);
    for (const [id, t] of tokens) if (t.fleetId === fleetId) tokens.delete(id);
    for (const [id, e] of tokenEvents) if (e.fleetId === fleetId) tokenEvents.delete(id);
    for (const [id, c] of collectors) {
      if (c.fleetId !== fleetId) continue;
      collectors.delete(id);
      for (const [errorId, e] of collectorErrors) if (e.collectorId === id) collectorErrors.delete(errorId);
    }
  }

  function deleteFleet(request: FleetRequest, fleetId: string): Reply {
    if (fleetOf(request.organizationId, fleetId) === undefined) return fleetNotFound();
    removeFleet(fleetId);
    return noContent();
  }

  // -------------------------------------------------------------------------
  // Collector groups (management/collector_groups.go; store/collectorgroups).

  interface GroupFields {
    assignedPublicationId?: string | null;
    annotations?: JsonObject | null;
    variableGroupId?: string | null;
  }

  /** The body's optional group fields: absent unset, null cleared; the annotations made canonical (400 when refused). */
  function groupFieldsOf(body: JsonObject, bodyText: string): GroupFields | Reply {
    const fields: GroupFields = {};
    if ("assignedPublicationId" in body) {
      const id = body.assignedPublicationId;
      fields.assignedPublicationId = id === null ? null : String(id).toLowerCase();
    }
    if ("variableGroupId" in body) {
      const id = body.variableGroupId;
      fields.variableGroupId = id === null ? null : String(id).toLowerCase();
    }
    if ("annotations" in body) {
      if (body.annotations === null) {
        fields.annotations = null;
      } else {
        const canonical = canonicalAnnotations(body.annotations as Json, fieldAsWritten(bodyText, "annotations"));
        if (canonical === undefined) return invalidRequest(MESSAGE_ANNOTATIONS);
        fields.annotations = canonical;
      }
    }
    return fields;
  }

  /**
   * checkLinks (D20 Task 5's order): what next newly names, a published
   * version the organization's (422), a variable group the organization's
   * (422), the new published version's names defined (422
   * variables_undefined); then the name unique in the fleet (409).
   */
  function groupLinksRefused(current: StoredGroup | undefined, g: StoredGroup, self: string): Reply | undefined {
    const newPublication =
      g.assignedPublicationId !== null && g.assignedPublicationId !== current?.assignedPublicationId ? g.assignedPublicationId : null;
    const newVariableGroup = g.variableGroupId !== null && g.variableGroupId !== current?.variableGroupId ? g.variableGroupId : null;
    if (newPublication !== null && options.publication(g.organizationId, newPublication) === undefined) {
      return errorReply(422, "publication_not_found", MESSAGE_PUBLICATION_NOT_FOUND);
    }
    const refused = variableGroupMissing(g.organizationId, newVariableGroup) ?? undefinedRefused(g.organizationId, newPublication);
    if (refused !== undefined) return refused;
    const taken = [...groups.values()].some(
      (other) =>
        other.id !== self && other.organizationId === g.organizationId && other.fleetId === g.fleetId && other.name === g.name,
    );
    if (taken) return errorReply(409, "collector_group_name_taken", MESSAGE_GROUP_NAME_TAKEN);
    return undefined;
  }

  /** stampOf: the counter moved on when the group's variable group is set, changed or cleared; else its stamp as it was. */
  function groupStampOf(current: StoredGroup | undefined, next: StoredGroup): number | null {
    if (next.variableGroupId === (current?.variableGroupId ?? null)) return current?.variableGroupStamp ?? null;
    return options.variables.bump(next.organizationId);
  }

  function listCollectorGroups(request: FleetRequest, fleetId: string): Reply {
    if (fleetOf(request.organizationId, fleetId) === undefined) return fleetNotFound();
    const listed = [...groups.values()]
      .filter((g) => g.organizationId === request.organizationId && g.fleetId === fleetId)
      .sort((a, b) =>
        a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : compareBytes(a.name, b.name) || compareIds(a.id, b.id),
      );
    return jsonReply(200, { groups: listed.map(groupJson) });
  }

  function createCollectorGroup(request: FleetRequest, fleetId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const fields = groupFieldsOf(body, request.bodyText);
    if (isReply(fields)) return fields;
    const fleet = fleetOf(request.organizationId, fleetId);
    if (fleet === undefined) return fleetNotFound();
    const now = nowMs();
    const group: StoredGroup = {
      id: randomUUID(),
      organizationId: request.organizationId,
      fleetId,
      name: body.name as string,
      isDefault: false,
      assignedPublicationId: fields.assignedPublicationId ?? null,
      annotations: fields.annotations ?? null,
      variableGroupId: fields.variableGroupId ?? null,
      variableGroupStamp: null,
      createdAt: now,
      updatedAt: now,
    };
    const refused = groupLinksRefused(undefined, group, "");
    if (refused !== undefined) return refused;
    group.variableGroupStamp = groupStampOf(undefined, group);
    groups.set(group.id, group);
    return jsonReply(201, groupJson(group));
  }

  function getCollectorGroup(request: FleetRequest, fleetId: string, groupId: string): Reply {
    const group = groupOf(request.organizationId, fleetId, groupId);
    return group === undefined
      ? childNotFound(request, fleetId, "collector_group_not_found", MESSAGE_GROUP_NOT_FOUND)
      : jsonReply(200, groupJson(group));
  }

  function updateCollectorGroup(request: FleetRequest, fleetId: string, groupId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const fields = groupFieldsOf(body, request.bodyText);
    if (isReply(fields)) return fields;
    const current = groupOf(request.organizationId, fleetId, groupId);
    if (current === undefined) return childNotFound(request, fleetId, "collector_group_not_found", MESSAGE_GROUP_NOT_FOUND);
    // Changes.apply: the name (the Default group keeps its own), then the
    // links only when something changed.
    const name = (body.name as string | undefined) ?? current.name;
    if (current.isDefault && name !== current.name) {
      return errorReply(409, "collector_group_is_default", MESSAGE_GROUP_IS_DEFAULT);
    }
    const next: StoredGroup = {
      ...current,
      name,
      assignedPublicationId:
        fields.assignedPublicationId === undefined ? current.assignedPublicationId : fields.assignedPublicationId,
      // On any fleet's group: an object replaces them whole, null clears them.
      annotations: fields.annotations === undefined ? current.annotations : fields.annotations,
      variableGroupId: fields.variableGroupId === undefined ? current.variableGroupId : fields.variableGroupId,
    };
    const changed =
      next.name !== current.name ||
      next.assignedPublicationId !== current.assignedPublicationId ||
      next.variableGroupId !== current.variableGroupId ||
      !sameJson(next.annotations, current.annotations);
    if (!changed) return jsonReply(200, groupJson(current));
    const refused = groupLinksRefused(current, next, groupId);
    if (refused !== undefined) return refused;
    next.variableGroupStamp = groupStampOf(current, next);
    next.updatedAt = nowMs();
    groups.set(groupId, next);
    return jsonReply(200, groupJson(next));
  }

  function deleteCollectorGroup(request: FleetRequest, fleetId: string, groupId: string): Reply {
    const group = groupOf(request.organizationId, fleetId, groupId);
    if (group === undefined) return childNotFound(request, fleetId, "collector_group_not_found", MESSAGE_GROUP_NOT_FOUND);
    if (group.isDefault) return errorReply(409, "collector_group_is_default", MESSAGE_GROUP_IS_DEFAULT);
    // D17d-1 decision 3 (store/collectorgroups' Delete): the group's
    // collectors and their error history go with it, in one step.
    for (const c of [...collectors.values()]) {
      if (c.organizationId === request.organizationId && c.fleetId === fleetId && c.groupId === groupId) removeCollector(c.id);
    }
    groups.delete(groupId);
    return noContent();
  }

  // -------------------------------------------------------------------------
  // Enrollment tokens (management/enrollment_tokens.go; store/enrollmenttokens/memory.go).

  function listEnrollmentTokens(request: FleetRequest, fleetId: string): Reply {
    if (fleetOf(request.organizationId, fleetId) === undefined) return fleetNotFound();
    const since = nowMs() - ACTIVE_WINDOW_MS;
    const listed = [...tokens.values()]
      .filter((t) => t.organizationId === request.organizationId && t.fleetId === fleetId)
      .sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
      .map((t) => ({
        ...tokenJson(t),
        activeCollectors: [...collectors.values()].filter(
          (c) => c.organizationId === t.organizationId && c.fleetId === fleetId && c.enrollmentTokenId === t.id && c.lastSeenAt > since,
        ).length,
      }));
    return jsonReply(200, { tokens: listed });
  }

  /** currentRotate: the fleet's rotate tokens valid at now, one not yet rotated first, then the newest, then the greatest id. */
  function currentRotate(organizationId: string, fleetId: string, now: number): StoredToken | undefined {
    let best: StoredToken | undefined;
    for (const t of tokens.values()) {
      if (t.organizationId !== organizationId || t.fleetId !== fleetId || t.kind !== "rotate" || !validAt(t, now)) continue;
      const ahead =
        best === undefined ||
        (t.doRefresh !== best.doRefresh
          ? !t.doRefresh
          : t.createdAt !== best.createdAt
            ? t.createdAt > best.createdAt
            : compareIds(t.id, best.id) > 0);
      if (ahead) best = t;
    }
    return best;
  }

  function rotateEnrollmentToken(request: FleetRequest, fleetId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const now = nowMs();
    let expiresAt: number | null = null;
    if (body.expiresAt !== null) {
      const at = readInstant("expiresAt", body.expiresAt as string);
      if (typeof at !== "number") return at;
      expiresAt = at;
    }
    const graceEndsAt = readInstant("graceEndsAt", body.graceEndsAt as string);
    if (typeof graceEndsAt !== "number") return graceEndsAt;
    if (graceEndsAt <= now) return invalidRequest("graceEndsAt must be in the future.");
    if (expiresAt !== null && graceEndsAt > expiresAt) return invalidRequest("graceEndsAt must not be after expiresAt.");
    const actor = decodeActor(body.actor);
    const fleet = fleetOf(request.organizationId, fleetId);
    if (fleet === undefined) return fleetNotFound();
    if (fleet.status !== "active") return errorReply(409, "fleet_archived", MESSAGE_FLEET_ARCHIVED);
    const predecessor = currentRotate(request.organizationId, fleetId, now);
    if (predecessor !== undefined) {
      // A rotation never lengthens a token's life (Ruling 33).
      predecessor.expiresAt =
        predecessor.expiresAt !== null && predecessor.expiresAt < graceEndsAt ? predecessor.expiresAt : graceEndsAt;
      predecessor.doRefresh = true;
      addEvent(predecessor, "rotated", actor, now);
    }
    const token: StoredToken = {
      id: randomUUID(),
      organizationId: request.organizationId,
      fleetId,
      kind: "rotate",
      expiresAt,
      revokedAt: null,
      doRefresh: false,
      createdBy: actor,
      createdAt: now,
    };
    tokens.set(token.id, token);
    addEvent(token, "issued", actor, now);
    return {
      status: 201,
      headers: { ...NO_STORE },
      body: {
        id: token.id,
        bearer: newBearer(),
        expiresAt: formatOptional(expiresAt),
        predecessorId: predecessor?.id ?? null,
      },
    };
  }

  /**
   * enrollment_tokens.go's issueDefaultEnrollmentToken and the store's
   * IssueDefault (D17c-1 decision 29): the body, the fleet, archived, then a
   * valid default token (a default token never expires, so valid is not
   * revoked) answers 409; else a new default token, an `issued` event and
   * its bearer.
   */
  function issueDefaultEnrollmentToken(request: FleetRequest, fleetId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const actor = decodeActor(body.actor);
    const fleet = fleetOf(request.organizationId, fleetId);
    if (fleet === undefined) return fleetNotFound();
    if (fleet.status !== "active") return errorReply(409, "fleet_archived", MESSAGE_FLEET_ARCHIVED);
    if (validDefaultTokenOf(request.organizationId, fleetId) !== undefined) {
      return errorReply(409, "enrollment_token_default_exists", MESSAGE_DEFAULT_TOKEN_EXISTS);
    }
    const now = nowMs();
    const token: StoredToken = {
      id: randomUUID(),
      organizationId: request.organizationId,
      fleetId,
      kind: "default",
      expiresAt: null,
      revokedAt: null,
      doRefresh: false,
      createdBy: actor,
      createdAt: now,
    };
    tokens.set(token.id, token);
    addEvent(token, "issued", actor, now);
    return {
      status: 201,
      headers: { ...NO_STORE },
      body: { id: token.id, kind: token.kind, bearer: newBearer(), expiresAt: null },
    };
  }

  /** The fleet's valid (not revoked) default token: at most one (migration 00010's index). */
  function validDefaultTokenOf(organizationId: string, fleetId: string): StoredToken | undefined {
    return [...tokens.values()].find(
      (t) => t.organizationId === organizationId && t.fleetId === fleetId && t.kind === "default" && t.revokedAt === null,
    );
  }

  /**
   * The fleet's default token a seeding helper uses when given none: the
   * valid one, else (all revoked) its newest, so a helper refuses it as
   * revoked rather than as missing. Newest as the token list orders them
   * (createdAt, then id, both descending), not by the map's order.
   */
  function defaultTokenOf(organizationId: string, fleetId: string): StoredToken | undefined {
    const valid = validDefaultTokenOf(organizationId, fleetId);
    if (valid !== undefined) return valid;
    let newest: StoredToken | undefined;
    for (const t of tokens.values()) {
      if (t.organizationId !== organizationId || t.fleetId !== fleetId || t.kind !== "default") continue;
      if (newest === undefined || newestFirst({ at: t.createdAt, id: t.id }, { at: newest.createdAt, id: newest.id }) < 0) newest = t;
    }
    return newest;
  }

  function revealEnrollmentToken(request: FleetRequest, fleetId: string, tokenId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const token = tokenOf(request.organizationId, fleetId, tokenId);
    if (token === undefined) return childNotFound(request, fleetId, "enrollment_token_not_found", MESSAGE_TOKEN_NOT_FOUND);
    if (token.revokedAt !== null) return errorReply(409, "enrollment_token_revoked", MESSAGE_TOKEN_REVOKED);
    const now = nowMs();
    if (!validAt(token, now)) return errorReply(409, "enrollment_token_expired", MESSAGE_TOKEN_EXPIRED);
    addEvent(token, "viewed", decodeActor(body.actor), now);
    return {
      status: 200,
      headers: { ...NO_STORE },
      body: { id: token.id, kind: token.kind, bearer: newBearer(), expiresAt: formatOptional(token.expiresAt) },
    };
  }

  function revokeEnrollmentToken(request: FleetRequest, fleetId: string, tokenId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const token = tokenOf(request.organizationId, fleetId, tokenId);
    if (token === undefined) return childNotFound(request, fleetId, "enrollment_token_not_found", MESSAGE_TOKEN_NOT_FOUND);
    // Already revoked: the token as it is, changing nothing (a retry is safe).
    if (token.revokedAt === null) {
      token.revokedAt = nowMs();
      addEvent(token, "revoked", decodeActor(body.actor), token.revokedAt);
    }
    return jsonReply(200, tokenJson(token));
  }

  function listEnrollmentTokenEvents(request: FleetRequest, fleetId: string): Reply {
    const rawCursor = request.query.get("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeTimeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === undefined) return invalidRequest(MESSAGE_CURSOR);
    if (fleetOf(request.organizationId, fleetId) === undefined) return fleetNotFound();
    const matching = [...tokenEvents.values()]
      .filter((e) => e.organizationId === request.organizationId && e.fleetId === fleetId)
      .sort((a, b) => newestFirst({ at: a.occurredAt, id: a.id }, { at: b.occurredAt, id: b.id }))
      .filter((e) => cursor === undefined || newestFirst(cursor, { at: e.occurredAt, id: e.id }) < 0);
    const { page, next } = pageOf(matching, listLimit(request.query), (last) => encodeTimeCursor(last.occurredAt, last.id));
    return jsonReply(200, {
      events: page.map((e) => ({
        id: e.id,
        tokenId: e.tokenId,
        event: e.event,
        actor: actorJson(e.actor),
        occurredAt: formatMilliseconds(e.occurredAt),
      })),
      nextCursor: next,
    });
  }

  // -------------------------------------------------------------------------
  // Collectors (management/collectors.go; store/collectors/memory.go).

  function refOf(pin: Json | undefined): Ref | null {
    if (pin === null || pin === undefined || typeof pin !== "object" || Array.isArray(pin)) return null;
    return { kind: pin.kind as Ref["kind"], id: String(pin.id).toLowerCase() };
  }

  function listCollectorInstances(request: FleetRequest, fleetId: string): Reply {
    const { query, organizationId } = request;
    const sort = (query.get("sort") ?? "created") as Sort;
    const order = (query.get("order") ?? "desc") as Order;
    const rawCursor = query.get("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeCollectorCursor(rawCursor);
    if (rawCursor !== undefined && cursor === undefined) return invalidRequest(MESSAGE_CURSOR);
    // checkOptions: a cursor of another sort or order is a 400, before the fleet is read.
    if (cursor !== undefined && (cursor.sort !== sort || cursor.order !== order)) return invalidRequest(MESSAGE_CURSOR);
    if (fleetOf(organizationId, fleetId) === undefined) {
      // As Postgres answers (Ruling 38): a page after a cursor is read
      // without checking the fleet (empty); a first page checks it.
      return cursor === undefined ? fleetNotFound() : jsonReply(200, { collectors: [], nextCursor: null });
    }
    const q = query.get("q")?.toLowerCase() ?? "";
    const groupId = query.get("groupId")?.toLowerCase();
    const at = cursor === undefined ? undefined : { createdAt: cursor.at, lastSeenAt: cursor.at, name: cursor.name, id: cursor.id };
    const matching = [...collectors.values()]
      .filter((c) => c.organizationId === organizationId && c.fleetId === fleetId)
      .filter((c) => groupId === undefined || c.groupId === groupId)
      .filter(
        (c) =>
          q === "" ||
          [c.name, c.reported.ip, c.reported.hostIp].some((field) => field !== null && field.toLowerCase().includes(q)),
      )
      .filter((c) => at === undefined || compareListed(c, at, sort, order) > 0)
      .sort((a, b) => compareListed(a, b, sort, order));
    const now = nowMs();
    const { page, next } = pageOf(matching, listLimit(query), (last) => encodeCollectorCursor(last, sort, order));
    return jsonReply(200, { collectors: page.map((c) => collectorJson(c, now)), nextCursor: next });
  }

  function pinCollectorInstances(request: FleetRequest, fleetId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const ids = [...new Set((body.collectorIds as string[]).map((id) => id.toLowerCase()))].sort(compareIds);
    // D20 (Q103): at least one of `pin` and `pinnedVariableGroupId`; one
    // left out leaves each collector's as it is.
    const pinGiven = "pin" in body;
    const ref = refOf(body.pin);
    const variableGroupGiven = "pinnedVariableGroupId" in body;
    const variableGroup = typeof body.pinnedVariableGroupId === "string" ? body.pinnedVariableGroupId.toLowerCase() : null;
    const { organizationId } = request;
    // The store's order: the fleet, the pin's target, the variable group, the pin's names defined.
    if (fleetOf(organizationId, fleetId) === undefined) return fleetNotFound();
    const refused =
      (pinGiven ? pinTargetMissing(organizationId, ref) : undefined) ??
      (variableGroupGiven ? variableGroupMissing(organizationId, variableGroup) : undefined) ??
      (pinGiven ? undefinedRefused(organizationId, ref?.id ?? null) : undefined);
    if (refused !== undefined) return refused;
    const updated: string[] = [];
    const notFound: string[] = [];
    const matched: StoredCollector[] = [];
    for (const id of ids) {
      const c = collectorOf(organizationId, fleetId, id);
      if (c === undefined) {
        notFound.push(id);
        continue;
      }
      updated.push(id);
      matched.push(c);
    }
    // The counter moves on once, when any of them changes its pinned variable group.
    const stamp =
      variableGroupGiven && matched.some((c) => c.pinnedVariableGroupId !== variableGroup) ? options.variables.bump(organizationId) : null;
    const now = nowMs();
    for (const c of matched) {
      if (pinGiven && !sameJson(c.pinned as Json, ref as Json)) {
        c.pinned = ref === null ? null : { ...ref };
        c.updatedAt = now;
      }
      if (variableGroupGiven && c.pinnedVariableGroupId !== variableGroup) {
        c.pinnedVariableGroupId = variableGroup;
        c.pinnedVariableGroupStamp = stamp;
        c.updatedAt = now;
      }
    }
    return jsonReply(200, { updated, notFound });
  }

  function getCollectorInstance(request: FleetRequest, fleetId: string, collectorId: string): Reply {
    const c = collectorOf(request.organizationId, fleetId, collectorId);
    return c === undefined
      ? childNotFound(request, fleetId, "collector_not_found", MESSAGE_COLLECTOR_NOT_FOUND)
      : jsonReply(200, collectorJson(c, nowMs()));
  }

  function updateCollectorInstance(request: FleetRequest, fleetId: string, collectorId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const { organizationId } = request;
    // All of them or none, checked in the Postgres store's order: the
    // collector, the group, the pin's target, the pinned variable group, the
    // pin's names defined (every pin, D20 Task 5), the name; then the stamp.
    const c = collectorOf(organizationId, fleetId, collectorId);
    if (c === undefined) return childNotFound(request, fleetId, "collector_not_found", MESSAGE_COLLECTOR_NOT_FOUND);
    const groupId = typeof body.groupId === "string" ? body.groupId.toLowerCase() : undefined;
    if (groupId !== undefined && groupOf(organizationId, fleetId, groupId) === undefined) {
      return errorReply(404, "collector_group_not_found", MESSAGE_GROUP_NOT_FOUND);
    }
    const pinGiven = "pin" in body;
    const ref = refOf(body.pin);
    const variableGroupGiven = "pinnedVariableGroupId" in body;
    const nextPinned = variableGroupGiven
      ? typeof body.pinnedVariableGroupId === "string"
        ? body.pinnedVariableGroupId.toLowerCase()
        : null
      : c.pinnedVariableGroupId;
    const refused =
      (pinGiven ? pinTargetMissing(organizationId, ref) : undefined) ??
      (variableGroupGiven ? variableGroupMissing(organizationId, nextPinned) : undefined) ??
      (pinGiven ? undefinedRefused(organizationId, ref?.id ?? null) : undefined);
    if (refused !== undefined) return refused;
    const name = body.name as string | undefined;
    if (name !== undefined && name !== c.name && nameTaken(organizationId, name, c.id)) {
      return errorReply(409, "collector_name_taken", MESSAGE_COLLECTOR_NAME_TAKEN);
    }
    let changed = c.pinnedVariableGroupId !== nextPinned;
    restamp(c, groupId ?? c.groupId, nextPinned);
    c.pinnedVariableGroupId = nextPinned;
    if (name !== undefined && name !== c.name) {
      c.name = name;
      changed = true;
    }
    if (groupId !== undefined && groupId !== c.groupId) {
      c.groupId = groupId;
      changed = true;
    }
    if (pinGiven && !sameJson(c.pinned as Json, ref as Json)) {
      c.pinned = ref;
      changed = true;
    }
    if (changed) c.updatedAt = nowMs();
    return jsonReply(200, collectorJson(c, nowMs()));
  }

  function removeCollector(id: string): void {
    collectors.delete(id);
    for (const [errorId, e] of collectorErrors) if (e.collectorId === id) collectorErrors.delete(errorId);
  }

  function deleteCollectorInstance(request: FleetRequest, fleetId: string, collectorId: string): Reply {
    if (collectorOf(request.organizationId, fleetId, collectorId) === undefined) {
      return childNotFound(request, fleetId, "collector_not_found", MESSAGE_COLLECTOR_NOT_FOUND);
    }
    removeCollector(collectorId);
    return noContent();
  }

  /** A collector's errors, newest first. */
  const errorsOf = (organizationId: string, collectorId: string) =>
    [...collectorErrors.values()]
      .filter((e) => e.organizationId === organizationId && e.collectorId === collectorId)
      .sort((a, b) => newestFirst({ at: a.reportedAt, id: a.id }, { at: b.reportedAt, id: b.id }));

  function listCollectorInstanceErrors(request: FleetRequest, fleetId: string, collectorId: string): Reply {
    const rawCursor = request.query.get("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeTimeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === undefined) return invalidRequest(MESSAGE_CURSOR);
    if (collectorOf(request.organizationId, fleetId, collectorId) === undefined) {
      return childNotFound(request, fleetId, "collector_not_found", MESSAGE_COLLECTOR_NOT_FOUND);
    }
    const matching = errorsOf(request.organizationId, collectorId).filter(
      (e) => cursor === undefined || newestFirst(cursor, { at: e.reportedAt, id: e.id }) < 0,
    );
    const { page, next } = pageOf(matching, listLimit(request.query), (last) => encodeTimeCursor(last.reportedAt, last.id));
    return jsonReply(200, {
      errors: page.map((e) => ({
        id: e.id,
        reportedAt: formatMilliseconds(e.reportedAt),
        configSha256: e.configSha256,
        message: e.message,
      })),
      nextCursor: next,
    });
  }

  // -------------------------------------------------------------------------
  // Limits and usage (management/limits.go, usage.go; publications' Usage).

  const limitsOf = (organizationId: string): StoredLimits =>
    limits.get(organizationId) ?? { maxCollectors: null, requestsPerMinute: null };

  function setLimits(request: FleetRequest): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const stored: StoredLimits = {
      maxCollectors: body.maxCollectors as number | null,
      requestsPerMinute: body.requestsPerMinute as number | null,
    };
    limits.set(request.organizationId, stored);
    return jsonReply(200, { ...stored });
  }

  /** The collector groups bound to, and the collectors pinned on, the organization's variable group (D20). */
  function variableGroupUses(organizationId: string, variableGroupId: string) {
    return {
      groups: [...groups.values()]
        .filter((g) => g.organizationId === organizationId && g.variableGroupId === variableGroupId)
        .map((g) => ({ fleetId: g.fleetId, groupId: g.id })),
      pinned: [...collectors.values()].filter((c) => c.organizationId === organizationId && c.pinnedVariableGroupId === variableGroupId)
        .length,
    };
  }

  /** The groups assigned, and the collectors pinned to, the organization's publication. */
  function usesOf(organizationId: string, publicationId: string): { groups: StoredGroup[]; pinned: number } {
    return {
      groups: [...groups.values()].filter(
        (g) => g.organizationId === organizationId && g.assignedPublicationId === publicationId,
      ),
      pinned: [...collectors.values()].filter(
        (c) => c.organizationId === organizationId && c.pinned?.kind === "publication" && c.pinned.id === publicationId,
      ).length,
    };
  }

  function getConfigurationUsage(request: FleetRequest): Reply {
    const configurationId = (request.pathValues.get("configurationId") as string).toLowerCase();
    let inUse = false;
    const publications = options
      .publicationsOf(request.organizationId, configurationId)
      .sort((a, b) => newestFirst({ at: a.publishedAt, id: a.id }, { at: b.publishedAt, id: b.id }))
      .map((p) => {
        const uses = usesOf(request.organizationId, p.id);
        // A markPublicationInUse mark is one phantom pinned collector.
        const pinnedCollectors = uses.pinned + (options.isMarkedInUse(request.organizationId, p.id) ? 1 : 0);
        inUse ||= uses.groups.length > 0 || pinnedCollectors > 0;
        return {
          id: p.id,
          version: { ...p.version },
          publishedAt: formatMilliseconds(p.publishedAt),
          groups: uses.groups
            .sort((a, b) => compareIds(a.fleetId, b.fleetId) || compareIds(a.id, b.id))
            .map((g) => ({ fleetId: g.fleetId, groupId: g.id })),
          pinnedCollectors,
        };
      });
    return jsonReply(200, { configurationId, inUse, publications });
  }

  // -------------------------------------------------------------------------
  // Dispatch.

  function answer(request: FleetRequest): Reply | undefined {
    const id = (name: string) => (request.pathValues.get(name) ?? "").toLowerCase();
    const fleetId = id("fleetId");
    switch (request.operationId) {
      case "getConfigurationUsage":
        return getConfigurationUsage(request);
      case "getLimits":
        return jsonReply(200, { ...limitsOf(request.organizationId) });
      case "setLimits":
        return setLimits(request);
      case "createFleet":
        return createFleet(request);
      case "listFleets":
        return listFleets(request);
      case "getFleet":
        return getFleet(request, fleetId);
      case "updateFleet":
        return updateFleet(request, fleetId);
      case "deleteFleet":
        return deleteFleet(request, fleetId);
      case "listCollectorGroups":
        return listCollectorGroups(request, fleetId);
      case "createCollectorGroup":
        return createCollectorGroup(request, fleetId);
      case "getCollectorGroup":
        return getCollectorGroup(request, fleetId, id("groupId"));
      case "updateCollectorGroup":
        return updateCollectorGroup(request, fleetId, id("groupId"));
      case "deleteCollectorGroup":
        return deleteCollectorGroup(request, fleetId, id("groupId"));
      case "listEnrollmentTokens":
        return listEnrollmentTokens(request, fleetId);
      case "listEnrollmentTokenEvents":
        return listEnrollmentTokenEvents(request, fleetId);
      case "rotateEnrollmentToken":
        return rotateEnrollmentToken(request, fleetId);
      case "issueDefaultEnrollmentToken":
        return issueDefaultEnrollmentToken(request, fleetId);
      case "revealEnrollmentToken":
        return revealEnrollmentToken(request, fleetId, id("tokenId"));
      case "revokeEnrollmentToken":
        return revokeEnrollmentToken(request, fleetId, id("tokenId"));
      case "listCollectorInstances":
        return listCollectorInstances(request, fleetId);
      case "pinCollectorInstances":
        return pinCollectorInstances(request, fleetId);
      case "getCollectorInstance":
        return getCollectorInstance(request, fleetId, id("collectorId"));
      case "updateCollectorInstance":
        return updateCollectorInstance(request, fleetId, id("collectorId"));
      case "deleteCollectorInstance":
        return deleteCollectorInstance(request, fleetId, id("collectorId"));
      case "listCollectorInstanceErrors":
        return listCollectorInstanceErrors(request, fleetId, id("collectorId"));
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // The helpers tests use in place of an agent.

  function requireCollector(organizationId: string, collectorId: string): StoredCollector {
    const c = collectors.get(collectorId.toLowerCase());
    if (c === undefined || c.organizationId !== organizationId.toLowerCase()) {
      throw new Error("the organization holds no such collector");
    }
    return c;
  }

  /**
   * What the store keeps of a report, bounded as the agent side bounds it
   * (handlers/report.go's observe): a collector version (stringAttribute
   * trims it of Go's spaces) only when it is then 1 to 200 characters, an
   * address only when, trimmed likewise, it is 1 to 100, else the stored
   * value stays; attributes as boundedAttributes
   * keeps them. Null clears a field (no agent does; tests may).
   */
  function reportedOf(current: StoredCollector["reported"], changes: ReportedState): StoredCollector["reported"] {
    const text = (given: string | null | undefined, stored: string | null, max: number, trim: boolean) => {
      if (given === undefined) return stored;
      if (given === null) return null;
      const value = trim ? given.replace(GO_TRIM, "") : given;
      return validText(value, 1, max) ? value : stored;
    };
    return {
      collectorVersion: text(changes.collectorVersion, current.collectorVersion, MAX_COLLECTOR_VERSION_LENGTH, true),
      ip: text(changes.ip, current.ip, MAX_ADDRESS_LENGTH, true),
      hostIp: text(changes.hostIp, current.hostIp, MAX_ADDRESS_LENGTH, true),
      attributes:
        changes.attributes === undefined
          ? current.attributes
          : changes.attributes === null
            ? null
            : boundedAttributes(changes.attributes),
    };
  }

  /** collectors' Enroll, as a collector's first poll would: its group, the cap, its token, a free name. */
  function enrollCollector(organizationIdIn: string, fleetIdIn: string, enroll: EnrollCollectorOptions = {}): EnrolledCollector {
    const organizationId = organizationIdIn.toLowerCase();
    const fleetId = fleetIdIn.toLowerCase();
    const fleet = fleetOf(organizationId, fleetId);
    if (fleet === undefined) throw new Error("enrollCollector: the organization holds no such fleet");
    const group =
      enroll.groupId === undefined
        ? defaultGroupOf(organizationId, fleetId)
        : groupOf(organizationId, fleetId, enroll.groupId.toLowerCase());
    if (group === undefined) throw new Error("enrollCollector: the fleet holds no such group");
    const { maxCollectors } = limitsOf(organizationId);
    const enrolled = [...collectors.values()].filter((c) => c.organizationId === organizationId).length;
    if (maxCollectors !== null && enrolled >= maxCollectors) throw new Error("enrollCollector: the organization's cap is reached");
    const token =
      enroll.tokenId === undefined
        ? defaultTokenOf(organizationId, fleetId)
        : tokenOf(organizationId, fleetId, enroll.tokenId.toLowerCase());
    if (token === undefined) throw new Error("enrollCollector: the fleet holds no such token");
    // As middleware/auth.go refuses a bearer: a revoked or expired token
    // (401), then an archived fleet (403).
    if (!validAt(token, nowMs())) throw new Error("enrollCollector: the token is revoked or expired");
    if (fleet.status !== "active") throw new Error("enrollCollector: the fleet is archived");
    let name = enroll.name;
    if (name === undefined) {
      do name = `collector-${++petnames}`;
      while (nameTaken(organizationId, name, ""));
    } else if (!validName(name, 200) || nameTaken(organizationId, name, "")) {
      throw new Error("enrollCollector: the name is invalid or taken");
    }
    const now = nowMs();
    const c: StoredCollector = {
      id: randomUUID(),
      organizationId,
      fleetId,
      groupId: group.id,
      instanceUid: randomUUID(),
      name,
      pinned: null,
      pinnedVariableGroupId: null,
      pinnedVariableGroupStamp: null,
      served: null,
      servedVariablesStamp: null,
      effective: null,
      reported: reportedOf({ collectorVersion: null, ip: null, hostIp: null, attributes: null }, enroll.reported ?? {}),
      enrollmentTokenId: token.id,
      lastSeenAt: enroll.lastSeenAt?.getTime() ?? now,
      createdAt: now,
      updatedAt: now,
    };
    collectors.set(c.id, c);
    return { id: c.id, instanceUid: c.instanceUid, name: c.name };
  }

  function setCollectorState(organizationId: string, collectorId: string, changes: CollectorStateChanges): void {
    const c = requireCollector(organizationId, collectorId);
    const now = nowMs();
    if (changes.served !== undefined) {
      const served = changes.served;
      if (served === null) {
        c.served = null;
        c.servedVariablesStamp = null;
      } else {
        let ref: Ref | null = null;
        let sha256 = served.sha256;
        if (served.kind !== null) {
          ref = { kind: served.kind, id: served.id.toLowerCase() };
          const target = options.publication(c.organizationId, ref.id);
          if (target === undefined) throw new Error("setCollectorState: the served target isn't held");
          sha256 ??= target.sha256;
        }
        c.served = { ref, sha256: sha256 as string, at: served.at === undefined ? now : (served.at?.getTime() ?? null) };
        // As a poll serving now records it: the newest stamp it filled in with.
        c.servedVariablesStamp =
          served.variablesStamp !== undefined ? served.variablesStamp : ref === null ? null : (resolve(c)?.wanted ?? null);
      }
    }
    if (changes.effective !== undefined) {
      const effective = changes.effective;
      // Effective's error column (effectiveError): its bounded message with
      // failed, else cleared. A failure without a message (none, or Go's
      // spaces only) records report.go's emptyFailureMessage, as effectiveOf.
      const given = effective?.error ?? "";
      const error =
        effective === null || effective.status !== "failed"
          ? ""
          : boundMessage(given.replace(GO_TRIM, "") === "" ? EMPTY_FAILURE_MESSAGE : given);
      c.effective =
        effective === null
          ? null
          : { sha256: effective.sha256, status: effective.status, error: error === "" ? null : error, at: effective.at?.getTime() ?? now };
    }
    if (changes.lastSeenAt !== undefined) c.lastSeenAt = changes.lastSeenAt.getTime();
    if (changes.reported !== undefined) c.reported = reportedOf(c.reported, changes.reported);
  }

  function recordCollectorError(organizationId: string, collectorId: string, report: CollectorErrorReport): { id: string } {
    const c = requireCollector(organizationId, collectorId);
    // ErrorReport's validate: the message bounded, and empty after that refused.
    const message = boundMessage(report.message);
    if (message === "") throw new Error("recordCollectorError: the message is empty");
    const stored: StoredError = {
      id: randomUUID(),
      organizationId: c.organizationId,
      collectorId: c.id,
      reportedAt: report.reportedAt?.getTime() ?? nowMs(),
      configSha256: report.configSha256 ?? null,
      message,
    };
    collectorErrors.set(stored.id, stored);
    // The history is trimmed to its newest 100.
    for (const old of errorsOf(c.organizationId, c.id).slice(MAX_ERRORS)) collectorErrors.delete(old.id);
    return { id: stored.id };
  }

  function recordTokenEvents(organizationIdIn: string, fleetIdIn: string, seeding: TokenEventSeeding): { count: number } {
    const organizationId = organizationIdIn.toLowerCase();
    const fleetId = fleetIdIn.toLowerCase();
    if (fleetOf(organizationId, fleetId) === undefined) throw new Error("recordTokenEvents: the organization holds no such fleet");
    if (!Number.isInteger(seeding.count) || seeding.count < 1 || seeding.count > MAX_SEEDED_EVENTS) {
      throw new Error("recordTokenEvents: the count is out of range");
    }
    const token =
      seeding.tokenId === undefined
        ? defaultTokenOf(organizationId, fleetId)
        : tokenOf(organizationId, fleetId, seeding.tokenId.toLowerCase());
    if (token === undefined) throw new Error("recordTokenEvents: the fleet holds no such token");
    const newest = seeding.occurredAt?.getTime() ?? nowMs();
    // Every event a time the contract's date-time can carry.
    if (newest >= AFTER_LATEST_INSTANT) throw new Error("recordTokenEvents: the newest event is after the year 9999");
    if (newest - (seeding.count - 1) < EARLIEST_INSTANT) throw new Error("recordTokenEvents: the oldest event is before the year 0001");
    const actor = seeding.actor === undefined || seeding.actor === null ? null : { id: seeding.actor.id.toLowerCase(), email: seeding.actor.email };
    for (let k = 0; k < seeding.count; k++) addEvent(token, seeding.event ?? "viewed", actor, newest - k);
    return { count: seeding.count };
  }

  function snapshotOf(organizationIdIn: string): Record<string, unknown> {
    const organizationId = organizationIdIn.toLowerCase();
    const of = <T extends { id: string; organizationId: string }>(rows: Map<string, T>) =>
      structuredClone([...rows.values()].filter((r) => r.organizationId === organizationId).sort((a, b) => compareIds(a.id, b.id)));
    return {
      fleets: of(fleets),
      groups: of(groups),
      tokens: of(tokens),
      collectors: of(collectors),
      collectorErrors: of(collectorErrors),
      tokenEvents: of(tokenEvents),
      limits: structuredClone(limits.get(organizationId) ?? null),
    };
  }

  return {
    answer,
    publicationUsed(organizationId, publicationId) {
      const uses = usesOf(organizationId, publicationId);
      return uses.groups.length > 0 || uses.pinned > 0;
    },
    publicationUses(organizationId, publicationId) {
      const uses = usesOf(organizationId, publicationId);
      return {
        groups: uses.groups.map((g) => ({ fleetId: g.fleetId, groupId: g.id })),
        // A markPublicationInUse mark is one phantom pinned collector, as the usage counts it.
        pinned: uses.pinned + (options.isMarkedInUse(organizationId, publicationId) ? 1 : 0),
      };
    },
    variableGroupUses,
    publicationDeleted(organizationId, publicationId) {
      for (const c of collectors.values()) {
        if (c.organizationId === organizationId && c.served?.ref?.kind === "publication" && c.served.ref.id === publicationId) {
          c.served.ref = null;
        }
      }
    },
    deleteOrganization(organizationId) {
      for (const f of [...fleets.values()]) if (f.organizationId === organizationId) removeFleet(f.id);
      limits.delete(organizationId);
    },
    enrollCollector,
    setCollectorState,
    recordCollectorError,
    recordTokenEvents,
    snapshotOf,
  };
}
