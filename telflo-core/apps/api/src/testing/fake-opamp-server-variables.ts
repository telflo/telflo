import { randomUUID } from "node:crypto";
import {
  actorJson,
  compareBytes,
  compareIds,
  decodeActor,
  errorReply,
  formatMilliseconds,
  isReply,
  jsonReply,
  noContent,
  type FleetRequest,
  type Json,
  type JsonObject,
  type Reply,
} from "./fake-opamp-server-fleets.js";

// The fake opamp-server's organization variables (D20 Task 9), for tests
// only: an organization's variables, its variable groups and their
// overrides, behind the 11 routes of openapi.yaml's `variables` and
// `variable groups` tags. fake-opamp-server.ts checks every request and
// reply against the contract and hands this module the 11 operations once
// a request's path ids are read and its organization is found registered;
// the fleet model (fake-opamp-server-fleets.ts) reads the bindings' checks
// and stamps from it. It never ships (.dockerignore leaves apps/api/src/testing
// out of the images; a lint rule keeps production code from importing it).
//
// Ported from the opamp-server's Go at D20 Tasks 3 to 6:
// - management/variables.go and variables_request.go: each route's check
//   order (the path's ids, the organization, the body, then the store's
//   answers), its fixed messages and its replies;
// - store/variables/memory.go: the semantics, each check before any change
//   (the id in the organization, the name, the limit, another
//   organization's id; the guards), then the counter's bump and the writes;
//   an override's Reset keeping its row with no value (a reset row, Q100),
//   ignored when filling in, never counted or answered, revived as new
//   (201) by a later override; the same value again changing nothing (200);
// - store/variableuse: the guards' details, at most 100 entries with exact
//   totals (Q102; the controller's (a));
// - store/orgvariables: References (render.go's scanner: a live
//   `${org:NAME}` is opened by a `$` an even run of `$` precedes) and Choose
//   (stamps.go: each variable read from the pin's variable group's override
//   row, then the collector group's, then the variable; the stamp the
//   greatest among the rows read down to the first with a value).
//
// Every write that can change a collector's filled-in text moves the
// organization's counter on once (Ruling 63) and stamps the row that
// changed with it (Q91, Q100): a variable's create, value change, rename and
// delete (the delete stamps nothing: its row is gone), an override's set,
// change or Reset, and (the fleet model's) a group's or a pin's
// variable-group setting and a move. A description, a variable group's
// create, name, description or delete, the same value again and a refused
// write move nothing. A variable group's own row has no stamp; its
// changedBy and changedAt move, for display only.
//
// A value, a name and a description are configuration text (Q88): no
// message here quotes one. There are no secrets: nothing is masked.

/** The most variables (Q104; Q90's 500 lowered) and variable groups (Q90) an organization may have. */
export const MAX_VARIABLES = 150;
export const MAX_VARIABLE_GROUPS = 100;
/** The most entries a guard's details list (Q102): each with its exact total. */
export const MAX_LISTED = 100;
/** A variable's name: at most 128 characters (Ruling 51). */
export const MAX_VARIABLE_NAME_LENGTH = 128;

// The fixed messages (management/variables.go). None quotes a value.
const MESSAGE_VARIABLE_NOT_FOUND = "The organization holds no variable with this id.";
export const MESSAGE_VARIABLE_GROUP_NOT_FOUND = "The organization holds no variable group with this id.";
const MESSAGE_VARIABLE_NAME_TAKEN = "Another of the organization's variables has this name.";
const MESSAGE_VARIABLE_GROUP_NAME_TAKEN = "Another of the organization's variable groups has this name.";
const MESSAGE_VARIABLE_IN_USE =
  "A published version that a collector group or a collector uses references this variable: assign or pin another version first.";
const MESSAGE_VARIABLE_GROUP_IN_USE = "A collector group or a collector uses this variable group: choose another for them first.";
export const MESSAGE_VARIABLES_UNDEFINED = "The published version references organization variables that aren't defined.";
const MESSAGE_VARIABLE_LIMIT_REACHED = "The organization has 150 variables, the most it may have.";
const MESSAGE_VARIABLE_GROUP_LIMIT_REACHED = "The organization has 100 variable groups, the most it may have.";
const MESSAGE_VARIABLE_CONFLICT = "A different variable already has this id.";
const MESSAGE_VARIABLE_GROUP_CONFLICT = "A different variable group already has this id.";

// ---------------------------------------------------------------------------
// References (store/orgvariables/render.go's scanner).

const OPENER = "${org:";

/** Whether an even number of `$` precede index i: the `$` at i opens a live reference. */
function precedingDollarRunEven(text: string, i: number): boolean {
  let count = 0;
  for (let k = i - 1; k >= 0 && text[k] === "$"; k--) count++;
  return count % 2 === 0;
}

/** The length of the longest NAME of the grammar [A-Za-z_][A-Za-z0-9_]* at text[from:], 0 when none starts there. */
function nameLength(text: string, from: number): number {
  let n = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const letter = c === 0x5f || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!letter && (n === 0 || c < 0x30 || c > 0x39)) break;
    n++;
  }
  return n;
}

/**
 * Every live reference's NAME in text, defined or not, each once, in the
 * order first seen (orgvariables.References): what a publication's names
 * are, as Put stores them. The legacy `$orgvar:NAME` and
 * `${org:NAME:-default}` are plain text.
 */
export function variableReferences(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; ) {
    const start = text.indexOf(OPENER, i);
    if (start < 0) break;
    const nameStart = start + OPENER.length;
    const nameEnd = nameStart + nameLength(text, nameStart);
    if (nameEnd === nameStart || nameEnd >= text.length || text[nameEnd] !== "}") {
      i = start + 1;
      continue;
    }
    const name = text.slice(nameStart, nameEnd);
    if (precedingDollarRunEven(text, start) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    i = nameEnd + 1;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Choose (store/orgvariables/stamps.go).

/** One level of a variable for a collector: its row there. A null value is a reset row. */
export interface Level {
  value: string | null;
  stamp: number;
}

/**
 * The value and the stamp of one variable for a collector: the levels read
 * from the top down (the pin's variable group's override row, the
 * collector group's, the variable), the source the first with a value, the
 * stamp the greatest among the rows read down to the source.
 */
export function choose(pin: Level | undefined, group: Level | undefined, organization: Level): { value: string; stamp: number } {
  let stamp = 0;
  for (const level of [pin, group, organization]) {
    if (level === undefined) continue;
    stamp = Math.max(stamp, level.stamp);
    if (level.value !== null) return { value: level.value, stamp };
  }
  return { value: "", stamp };
}

// ---------------------------------------------------------------------------
// The model.

interface Actor {
  id: string;
  email: string;
}

interface StoredVariable {
  id: string;
  organizationId: string;
  name: string;
  value: string;
  description: string | null;
  changedBy: Actor | null;
  /** Whole milliseconds. */
  changedAt: number;
  stamp: number;
}

interface StoredVariableGroup {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  changedBy: Actor | null;
  changedAt: number;
}

interface StoredOverride {
  organizationId: string;
  variableGroupId: string;
  variableId: string;
  /** Null for a reset row (Q100). */
  value: string | null;
  changedBy: Actor | null;
  changedAt: number;
  stamp: number;
}

/** A collector group, by its fleet and its id. */
export interface GroupRef {
  fleetId: string;
  groupId: string;
}

/** What uses a published version, or a variable group: the collector groups (any order) and the collectors pinned. */
export interface Uses {
  groups: GroupRef[];
  pinned: number;
}

export interface VariablesModelOptions {
  now: () => Date;
  /** The organization's publications whose names (Put's References) hold `name`. */
  publicationsNaming(organizationId: string, name: string): string[];
  /** The groups assigned the organization's publication and the collectors pinned to it (a mark counting one). */
  publicationUses(organizationId: string, publicationId: string): Uses;
  /** The collector groups bound to the organization's variable group and the collectors it is pinned on. */
  variableGroupUses(organizationId: string, variableGroupId: string): Uses;
}

export interface VariablesModel {
  /** The operation's answer, or undefined for an operation the model doesn't serve. */
  answer(request: FleetRequest): Reply | undefined;
  /** Whether the organization holds the variable group. */
  variableGroupHeld(organizationId: string, variableGroupId: string): boolean;
  /** The names of `names` no variable of the organization has: at most 100 in byte order, and their total. */
  undefinedNames(organizationId: string, names: string[]): { names: string[]; totalNames: number };
  /** Moves the organization's counter on by one and answers its new value. */
  bump(organizationId: string): number;
  /** The organization's counter: 0 until a change moved it. */
  revision(organizationId: string): number;
  /**
   * The stamp of the organization's variable `name` for a collector whose
   * pin uses `pinnedVariableGroupId` and whose group uses
   * `groupVariableGroupId` (choose), or undefined when no variable has the
   * name.
   */
  nameStamp(organizationId: string, name: string, pinnedVariableGroupId: string | null, groupVariableGroupId: string | null): number | undefined;
  /** The organization's delete: its variables, variable groups and overrides go. */
  deleteOrganization(organizationId: string): void;
  /** A deep copy of what the organization holds, each list sorted by id (overrides by group, then variable). */
  snapshotOf(organizationId: string): Record<string, unknown>;
}

/** Starts the variables model; fake-opamp-server.ts owns one. */
export function createVariablesModel(options: VariablesModelOptions): VariablesModel {
  const variables = new Map<string, StoredVariable>();
  const variableGroups = new Map<string, StoredVariableGroup>();
  /** By overrideKey: a variable group's id, then the variable's. */
  const overrides = new Map<string, StoredOverride>();
  const revisions = new Map<string, number>();

  const nowMs = () => options.now().getTime();
  const overrideKey = (variableGroupId: string, variableId: string) => `${variableGroupId}/${variableId}`;

  const variableOf = (organizationId: string, id: string) => {
    const v = variables.get(id);
    return v !== undefined && v.organizationId === organizationId ? v : undefined;
  };
  const variableGroupOf = (organizationId: string, id: string) => {
    const g = variableGroups.get(id);
    return g !== undefined && g.organizationId === organizationId ? g : undefined;
  };
  const variableByName = (organizationId: string, name: string) =>
    [...variables.values()].find((v) => v.organizationId === organizationId && v.name === name);
  const overrideOf = (organizationId: string, variableGroupId: string | null, variableId: string) => {
    if (variableGroupId === null) return undefined;
    const o = overrides.get(overrideKey(variableGroupId, variableId));
    return o !== undefined && o.organizationId === organizationId ? o : undefined;
  };

  function bump(organizationId: string): number {
    const next = (revisions.get(organizationId) ?? 0) + 1;
    revisions.set(organizationId, next);
    return next;
  }

  function variableJson(v: StoredVariable): JsonObject {
    return {
      id: v.id,
      name: v.name,
      value: v.value,
      description: v.description,
      changedBy: actorJson(v.changedBy),
      changedAt: formatMilliseconds(v.changedAt),
    };
  }

  function variableGroupJson(g: StoredVariableGroup): JsonObject {
    const uses = options.variableGroupUses(g.organizationId, g.id);
    const overrideCount = [...overrides.values()].filter(
      (o) => o.organizationId === g.organizationId && o.variableGroupId === g.id && o.value !== null,
    ).length;
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      overrideCount,
      usage: { collectorGroups: uses.groups.length, pinnedCollectors: uses.pinned },
      changedBy: actorJson(g.changedBy),
      changedAt: formatMilliseconds(g.changedAt),
    };
  }

  const overrideJson = (o: StoredOverride): JsonObject => ({
    variableId: o.variableId,
    value: o.value,
    changedBy: actorJson(o.changedBy),
    changedAt: formatMilliseconds(o.changedAt),
  });

  /** The body, or the reply refusing it. */
  function bodyOf(request: FleetRequest): JsonObject | Reply {
    const body = request.readBody();
    return isReply(body) ? body : (body as JsonObject);
  }

  const description = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);
  const compareRefs = (a: GroupRef, b: GroupRef) => compareIds(a.fleetId, b.fleetId) || compareIds(a.groupId, b.groupId);

  // -------------------------------------------------------------------------
  // The guards' details (store/variableuse).

  /**
   * UsedBy: the organization's used publications whose names hold `name`,
   * by id, each with its groups by fleet then group and its pinned count;
   * at most 100 entries in all (a group, or a publication with no group),
   * the last publication cut short; the totals exact.
   */
  function usedBy(organizationId: string, name: string): JsonObject | undefined {
    const all = options
      .publicationsNaming(organizationId, name)
      .map((publicationId) => ({ publicationId, ...options.publicationUses(organizationId, publicationId) }))
      .filter((use) => use.groups.length > 0 || use.pinned > 0)
      .sort((a, b) => compareIds(a.publicationId, b.publicationId));
    if (all.length === 0) return undefined;
    const usedBy: JsonObject[] = [];
    let entries = 0;
    let totalGroups = 0;
    let totalPinnedCollectors = 0;
    for (const use of all) {
      totalGroups += use.groups.length;
      totalPinnedCollectors += use.pinned;
      if (entries === MAX_LISTED) continue;
      const groups: JsonObject[] = [];
      if (use.groups.length === 0) entries++;
      for (const g of [...use.groups].sort(compareRefs)) {
        if (entries === MAX_LISTED) break;
        groups.push({ fleetId: g.fleetId, groupId: g.groupId });
        entries++;
      }
      usedBy.push({ publicationId: use.publicationId, groups, pinnedCollectors: use.pinned });
    }
    return { usedBy, totalPublications: all.length, totalGroups, totalPinnedCollectors };
  }

  /** GroupUse: the collector groups bound to the variable group, at most 100 by fleet then group, their total, and its pinned collectors. */
  function groupUse(organizationId: string, variableGroupId: string): JsonObject | undefined {
    const uses = options.variableGroupUses(organizationId, variableGroupId);
    if (uses.groups.length === 0 && uses.pinned === 0) return undefined;
    const sorted = [...uses.groups].sort(compareRefs);
    return {
      collectorGroups: sorted.slice(0, MAX_LISTED).map((g) => ({ fleetId: g.fleetId, groupId: g.groupId })),
      totalCollectorGroups: sorted.length,
      pinnedCollectors: uses.pinned,
    };
  }

  const withDetails = (status: number, code: string, message: string, details: JsonObject): Reply => {
    const reply = errorReply(status, code, message);
    ((reply.body as JsonObject).error as JsonObject).details = details;
    return reply;
  };

  // -------------------------------------------------------------------------
  // Variables.

  function listVariables(request: FleetRequest): Reply {
    const listed = [...variables.values()]
      .filter((v) => v.organizationId === request.organizationId)
      .sort((a, b) => compareBytes(a.name, b.name));
    return jsonReply(200, { variables: listed.map(variableJson) });
  }

  function createVariable(request: FleetRequest): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const { organizationId } = request;
    // Without an id the server makes one, so such a POST can't be safely retried.
    const id = typeof body.id === "string" ? body.id.toLowerCase() : randomUUID();
    const name = body.name as string;
    const value = body.value as string;
    const text = description(body.description);
    // The store's order: the id in the organization, the name, the limit,
    // then another organization's id (Ruling 59's edges).
    const existing = variableOf(organizationId, id);
    if (existing !== undefined) {
      if (existing.name === name && existing.value === value && existing.description === text) {
        return jsonReply(200, variableJson(existing));
      }
      return errorReply(409, "variable_conflict", MESSAGE_VARIABLE_CONFLICT);
    }
    if (variableByName(organizationId, name) !== undefined) {
      return errorReply(409, "variable_name_taken", MESSAGE_VARIABLE_NAME_TAKEN);
    }
    if ([...variables.values()].filter((v) => v.organizationId === organizationId).length >= MAX_VARIABLES) {
      return errorReply(409, "variable_limit_reached", MESSAGE_VARIABLE_LIMIT_REACHED);
    }
    if (variables.has(id)) return errorReply(409, "variable_conflict", MESSAGE_VARIABLE_CONFLICT);
    const stored: StoredVariable = {
      id,
      organizationId,
      name,
      value,
      description: text,
      changedBy: decodeActor(body.actor),
      changedAt: nowMs(),
      stamp: bump(organizationId),
    };
    variables.set(id, stored);
    return jsonReply(201, variableJson(stored));
  }

  function updateVariable(request: FleetRequest, variableId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const { organizationId } = request;
    const current = variableOf(organizationId, variableId);
    if (current === undefined) return errorReply(404, "variable_not_found", MESSAGE_VARIABLE_NOT_FOUND);
    const name = "name" in body ? (body.name as string) : current.name;
    const value = "value" in body ? (body.value as string) : current.value;
    const text = "description" in body ? description(body.description) : current.description;
    if (name !== current.name) {
      if (variableByName(organizationId, name) !== undefined) {
        return errorReply(409, "variable_name_taken", MESSAGE_VARIABLE_NAME_TAKEN);
      }
      const uses = usedBy(organizationId, current.name);
      if (uses !== undefined) return withDetails(409, "variable_in_use", MESSAGE_VARIABLE_IN_USE, uses);
    }
    const filled = name !== current.name || value !== current.value;
    if (!filled && text === current.description) return jsonReply(200, variableJson(current));
    // A value or a name a collector's text is filled in by: stamped. A
    // description alone changes nothing filled in.
    if (filled) current.stamp = bump(organizationId);
    current.name = name;
    current.value = value;
    current.description = text;
    current.changedBy = decodeActor(body.actor);
    current.changedAt = nowMs();
    return jsonReply(200, variableJson(current));
  }

  function deleteVariable(request: FleetRequest, variableId: string): Reply {
    const { organizationId } = request;
    const current = variableOf(organizationId, variableId);
    if (current === undefined) return errorReply(404, "variable_not_found", MESSAGE_VARIABLE_NOT_FOUND);
    const uses = usedBy(organizationId, current.name);
    if (uses !== undefined) return withDetails(409, "variable_in_use", MESSAGE_VARIABLE_IN_USE, uses);
    // Ruling 63: the counter moves on (the poll's cache is keyed by it), with no stamp: the row is gone.
    bump(organizationId);
    variables.delete(variableId);
    // Its overrides, reset rows included, go with it (on delete cascade).
    for (const [key, o] of overrides) if (o.organizationId === organizationId && o.variableId === variableId) overrides.delete(key);
    return noContent();
  }

  // -------------------------------------------------------------------------
  // Variable groups.

  function listVariableGroups(request: FleetRequest): Reply {
    const listed = [...variableGroups.values()]
      .filter((g) => g.organizationId === request.organizationId)
      .sort((a, b) => compareBytes(a.name, b.name));
    return jsonReply(200, { variableGroups: listed.map(variableGroupJson) });
  }

  const groupNameTaken = (organizationId: string, name: string) =>
    [...variableGroups.values()].some((g) => g.organizationId === organizationId && g.name === name);

  function createVariableGroup(request: FleetRequest): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const { organizationId } = request;
    const id = typeof body.id === "string" ? body.id.toLowerCase() : randomUUID();
    const name = body.name as string;
    const text = description(body.description);
    const existing = variableGroupOf(organizationId, id);
    if (existing !== undefined) {
      if (existing.name === name && existing.description === text) return jsonReply(200, variableGroupJson(existing));
      return errorReply(409, "variable_group_conflict", MESSAGE_VARIABLE_GROUP_CONFLICT);
    }
    if (groupNameTaken(organizationId, name)) {
      return errorReply(409, "variable_group_name_taken", MESSAGE_VARIABLE_GROUP_NAME_TAKEN);
    }
    if ([...variableGroups.values()].filter((g) => g.organizationId === organizationId).length >= MAX_VARIABLE_GROUPS) {
      return errorReply(409, "variable_group_limit_reached", MESSAGE_VARIABLE_GROUP_LIMIT_REACHED);
    }
    if (variableGroups.has(id)) return errorReply(409, "variable_group_conflict", MESSAGE_VARIABLE_GROUP_CONFLICT);
    // No bump: nothing filled in changes until a group or a pin uses it.
    const stored: StoredVariableGroup = {
      id,
      organizationId,
      name,
      description: text,
      changedBy: decodeActor(body.actor),
      changedAt: nowMs(),
    };
    variableGroups.set(id, stored);
    return jsonReply(201, variableGroupJson(stored));
  }

  function getVariableGroup(request: FleetRequest, variableGroupId: string): Reply {
    const { organizationId } = request;
    const g = variableGroupOf(organizationId, variableGroupId);
    if (g === undefined) return errorReply(404, "variable_group_not_found", MESSAGE_VARIABLE_GROUP_NOT_FOUND);
    // Its overrides with a value, never a reset row, by their variable's name.
    const listed = [...overrides.values()]
      .filter((o) => o.organizationId === organizationId && o.variableGroupId === variableGroupId && o.value !== null)
      .map((o) => ({ o, name: variableOf(organizationId, o.variableId)?.name ?? "" }))
      .sort((a, b) => compareBytes(a.name, b.name));
    return jsonReply(200, { variableGroup: variableGroupJson(g), overrides: listed.map(({ o }) => overrideJson(o)) });
  }

  function updateVariableGroup(request: FleetRequest, variableGroupId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const { organizationId } = request;
    const current = variableGroupOf(organizationId, variableGroupId);
    if (current === undefined) return errorReply(404, "variable_group_not_found", MESSAGE_VARIABLE_GROUP_NOT_FOUND);
    const name = "name" in body ? (body.name as string) : current.name;
    const text = "description" in body ? description(body.description) : current.description;
    if (name !== current.name && groupNameTaken(organizationId, name)) {
      return errorReply(409, "variable_group_name_taken", MESSAGE_VARIABLE_GROUP_NAME_TAKEN);
    }
    if (name === current.name && text === current.description) return jsonReply(200, variableGroupJson(current));
    current.name = name;
    current.description = text;
    current.changedBy = decodeActor(body.actor);
    current.changedAt = nowMs();
    return jsonReply(200, variableGroupJson(current));
  }

  function deleteVariableGroup(request: FleetRequest, variableGroupId: string): Reply {
    const { organizationId } = request;
    if (variableGroupOf(organizationId, variableGroupId) === undefined) {
      return errorReply(404, "variable_group_not_found", MESSAGE_VARIABLE_GROUP_NOT_FOUND);
    }
    const use = groupUse(organizationId, variableGroupId);
    if (use !== undefined) return withDetails(409, "variable_group_in_use", MESSAGE_VARIABLE_GROUP_IN_USE, use);
    variableGroups.delete(variableGroupId);
    for (const [key, o] of overrides) {
      if (o.organizationId === organizationId && o.variableGroupId === variableGroupId) overrides.delete(key);
    }
    return noContent();
  }

  /** The override's two path targets, or the 404 for the first missing (the group, then the variable). */
  function overrideTargets(request: FleetRequest, variableGroupId: string, variableId: string): StoredVariableGroup | Reply {
    const g = variableGroupOf(request.organizationId, variableGroupId);
    if (g === undefined) return errorReply(404, "variable_group_not_found", MESSAGE_VARIABLE_GROUP_NOT_FOUND);
    if (variableOf(request.organizationId, variableId) === undefined) {
      return errorReply(404, "variable_not_found", MESSAGE_VARIABLE_NOT_FOUND);
    }
    return g;
  }

  /** An override's change moves its variable group's changedBy and changedAt (display only). */
  function touch(g: StoredVariableGroup, actor: Actor | null, at: number): void {
    g.changedBy = actor === null ? null : { ...actor };
    g.changedAt = at;
  }

  function setVariableGroupOverride(request: FleetRequest, variableGroupId: string, variableId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const g = overrideTargets(request, variableGroupId, variableId);
    if (isReply(g)) return g;
    const value = body.value as string;
    const key = overrideKey(variableGroupId, variableId);
    const existing = overrides.get(key);
    // New when there is no row, or a reset one (preflight item 15).
    const created = existing === undefined || existing.value === null;
    if (!created && existing.value === value) return jsonReply(200, overrideJson(existing));
    const actor = decodeActor(body.actor);
    const at = nowMs();
    const stored: StoredOverride = {
      organizationId: request.organizationId,
      variableGroupId,
      variableId,
      value,
      changedBy: actor,
      changedAt: at,
      stamp: bump(request.organizationId),
    };
    overrides.set(key, stored);
    touch(g, actor, at);
    return jsonReply(created ? 201 : 200, overrideJson(stored));
  }

  function resetVariableGroupOverride(request: FleetRequest, variableGroupId: string, variableId: string): Reply {
    const body = bodyOf(request);
    if (isReply(body)) return body;
    const g = overrideTargets(request, variableGroupId, variableId);
    if (isReply(g)) return g;
    const existing = overrides.get(overrideKey(variableGroupId, variableId));
    // None, or already reset: 204, and nothing changes.
    if (existing === undefined || existing.value === null) return noContent();
    const actor = decodeActor(body.actor);
    const at = nowMs();
    // The row is kept with no value and the Reset's stamp (Q100).
    existing.value = null;
    existing.stamp = bump(request.organizationId);
    existing.changedBy = actor;
    existing.changedAt = at;
    touch(g, actor, at);
    return noContent();
  }

  // -------------------------------------------------------------------------
  // Dispatch.

  function answer(request: FleetRequest): Reply | undefined {
    const id = (name: string) => (request.pathValues.get(name) ?? "").toLowerCase();
    switch (request.operationId) {
      case "listVariables":
        return listVariables(request);
      case "createVariable":
        return createVariable(request);
      case "updateVariable":
        return updateVariable(request, id("variableId"));
      case "deleteVariable":
        return deleteVariable(request, id("variableId"));
      case "listVariableGroups":
        return listVariableGroups(request);
      case "createVariableGroup":
        return createVariableGroup(request);
      case "getVariableGroup":
        return getVariableGroup(request, id("variableGroupId"));
      case "updateVariableGroup":
        return updateVariableGroup(request, id("variableGroupId"));
      case "deleteVariableGroup":
        return deleteVariableGroup(request, id("variableGroupId"));
      case "setVariableGroupOverride":
        return setVariableGroupOverride(request, id("variableGroupId"), id("variableId"));
      case "resetVariableGroupOverride":
        return resetVariableGroupOverride(request, id("variableGroupId"), id("variableId"));
      default:
        return undefined;
    }
  }

  function nameStamp(
    organizationId: string,
    name: string,
    pinnedVariableGroupId: string | null,
    groupVariableGroupId: string | null,
  ): number | undefined {
    const v = variableByName(organizationId, name);
    if (v === undefined) return undefined;
    const level = (variableGroupId: string | null): Level | undefined => {
      const o = overrideOf(organizationId, variableGroupId, v.id);
      return o === undefined ? undefined : { value: o.value, stamp: o.stamp };
    };
    return choose(level(pinnedVariableGroupId), level(groupVariableGroupId), { value: v.value, stamp: v.stamp }).stamp;
  }

  return {
    answer,
    variableGroupHeld: (organizationId, variableGroupId) => variableGroupOf(organizationId, variableGroupId) !== undefined,
    undefinedNames(organizationId, names) {
      const all = names.filter((name) => variableByName(organizationId, name) === undefined).sort(compareBytes);
      return { names: all.slice(0, MAX_LISTED), totalNames: all.length };
    },
    bump,
    revision: (organizationId) => revisions.get(organizationId) ?? 0,
    nameStamp,
    deleteOrganization(organizationId) {
      for (const [id, v] of variables) if (v.organizationId === organizationId) variables.delete(id);
      for (const [id, g] of variableGroups) if (g.organizationId === organizationId) variableGroups.delete(id);
      for (const [key, o] of overrides) if (o.organizationId === organizationId) overrides.delete(key);
      revisions.delete(organizationId);
    },
    snapshotOf(organizationId) {
      const of = <T extends { id: string; organizationId: string }>(rows: Map<string, T>) =>
        structuredClone([...rows.values()].filter((r) => r.organizationId === organizationId).sort((a, b) => compareIds(a.id, b.id)));
      return {
        variables: of(variables),
        variableGroups: of(variableGroups),
        variableGroupOverrides: structuredClone(
          [...overrides.values()]
            .filter((o) => o.organizationId === organizationId)
            .sort((a, b) => compareIds(a.variableGroupId, b.variableGroupId) || compareIds(a.variableId, b.variableId)),
        ),
        variablesRevision: revisions.get(organizationId) ?? 0,
      };
    },
  };
}
