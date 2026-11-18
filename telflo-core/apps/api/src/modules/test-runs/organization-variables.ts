import type { OpampServerClient } from "../../opamp-server/client.js";

/*
 * Organization variables in a test run's text (D20 decisions 13 and 38;
 * Q92; Preflight ruling 28, the controller's (e)). The run's `yaml` is
 * saved and returned as written, `${org:NAME}` and all; the organization's
 * values are filled in only on the way to the tester, so its cleanup and
 * checks run on the filled-in text (the owner's invariant: values first,
 * then every cleanup and check). Only the organization's values: a test run
 * belongs to no collector group and no pin, so no variable group applies.
 *
 * The values are read twice, and only for a text with a live reference
 * (references(text) non-empty):
 *   - at queue (test-run-service.ts's step 7), to refuse early: unreadable,
 *     503 `variables_unavailable`; too long once filled in, 400
 *     `filled_in_too_long`. Nothing filled in is kept;
 *   - at dispatch (dispatcher.ts's carry), again, since they may have
 *     changed: unreadable, the run fails `variables_unavailable`; too long,
 *     `filled_in_too_long`; else the tester gets the filled-in text.
 *
 * A value is configuration text (Q88, ADR 0024): never logged, never in an
 * error's message, never stored outside the opamp-server.
 */

// ---------------------------------------------------------------------------
// D20's fill-in (decisions 8, 16, 33 and 36): the TypeScript port of the
// opamp-server's store/orgvariables (render.go), held to it by the shared
// corpus (vendor/opamp-server/org-token-corpus.json, the opamp-server's
// handlers/testdata/org-token-corpus.json at the pinned release).
//
// A live reference is `${org:NAME}`, NAME the grammar [A-Za-z_][A-Za-z0-9_]*
// of any length, opened by a `$` that an even run of `$` precedes. The
// legacy `$orgvar:NAME` form is plain text (decision 16), and so is
// `${org:NAME:-default}`. A known NAME's value is written with every `$`
// doubled, so the collector's confmap pass, which collapses `$$` to `$`,
// yields the value exactly; an unknown NAME is left as written. There is no
// YAML round trip.
//
// One scanner serves references, renderedLength and render, so they can't
// disagree. The length comes first (Preflight ruling 12): a text of many
// references to a long value of `$` fills in to far more than it is, so a
// caller measures it and refuses it before anything is built. Lengths are
// UTF-16 code units (`string.length`), the unit TEST_RUN_YAML_MAXIMUM_LENGTH
// counts (docs review (12)), not the Go port's bytes.

/** An organization's values, by NAME. A Map, so a NAME such as `constructor` is never an object's own property. */
export type OrganizationVariableValues = ReadonlyMap<string, string>;

/** No values: every reference stays as written. */
export const NO_VALUES: OrganizationVariableValues = new Map();

const OPENER = "${org:";

/**
 * True when an EVEN number of `$` immediately precede index `i`: confmap
 * collapses each `$$` in one left-to-right pass, so a reference opened by
 * the `$` at `i` is live iff the run before it is even. An odd run means
 * this `$` is the trailing half of a `$$` escape.
 */
function precedingDollarRunEven(text: string, i: number): boolean {
  let count = 0;
  for (let k = i - 1; k >= 0 && text.charCodeAt(k) === 0x24; k -= 1) count += 1;
  return count % 2 === 0;
}

/** The length of the longest NAME of the grammar at `text[from..]`, 0 when none starts there. */
function nameLength(text: string, from: number): number {
  let n = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const letter = c === 0x5f || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!letter && (n === 0 || c < 0x30 || c > 0x39)) break;
    n += 1;
  }
  return n;
}

/** Calls `visit` for each live reference in `text`, in order, with the bounds of its `${org:NAME}` and its NAME. */
function scan(text: string, visit: (start: number, end: number, name: string) => void): void {
  for (let i = 0; i < text.length; ) {
    const start = text.indexOf(OPENER, i);
    if (start < 0) return;
    const nameStart = start + OPENER.length;
    const nameEnd = nameStart + nameLength(text, nameStart);
    if (nameEnd === nameStart || nameEnd >= text.length || text.charCodeAt(nameEnd) !== 0x7d) {
      i = start + 1;
      continue;
    }
    const end = nameEnd + 1;
    if (precedingDollarRunEven(text, start)) visit(start, end, text.slice(nameStart, nameEnd));
    i = end;
  }
}

/** A value as it is written into the text: every `$` doubled (decision 8). */
function escapeValue(value: string): string {
  return value.split("$").join("$$");
}

/** How many `$` a value holds: its escaped form is this much longer. */
function dollarCount(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) === 0x24) count += 1;
  return count;
}

/**
 * Every live reference's NAME in `text`, defined or not, each once, in the
 * order first seen: orgvariables.References.
 */
export function references(text: string): string[] {
  return renderedLength(text, NO_VALUES).names;
}

/**
 * The length of `text` filled in with `values`, in UTF-16 code units,
 * counted without building it, and references(text). Each name's value is
 * measured once, however often the text references it.
 */
export function renderedLength(text: string, values: OrganizationVariableValues): { length: number; names: string[] } {
  let length = text.length;
  const names: string[] = [];
  // Each name's escaped value's length, or -1 for a name with no value.
  const lengths = new Map<string, number>();
  scan(text, (start, end, name) => {
    let escaped = lengths.get(name);
    if (escaped === undefined) {
      names.push(name);
      const value = values.get(name);
      escaped = value === undefined ? -1 : value.length + dollarCount(value);
      lengths.set(name, escaped);
    }
    if (escaped >= 0) length += escaped - (end - start);
  });
  return { length, names };
}

/**
 * `text` with each live reference to a name in `values` filled in, its
 * value's `$` doubled: orgvariables.Render. A text in which nothing is
 * filled in comes back as it is. The caller measures first
 * (renderedLength): this builds whatever length the fill-in comes to.
 */
export function render(text: string, values: OrganizationVariableValues): string {
  const escaped = new Map<string, string>();
  const parts: string[] = [];
  let cursor = 0;
  scan(text, (start, end, name) => {
    let written = escaped.get(name);
    if (written === undefined) {
      const value = values.get(name);
      // An unknown name is left as written.
      if (value === undefined) return;
      written = escapeValue(value);
      escaped.set(name, written);
    }
    parts.push(text.slice(cursor, start), written);
    cursor = end;
  });
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Where a run's values come from.

/** What a read of an organization's values answers. */
export type OrganizationVariablesRead =
  /** The organization's variables, NAME to value. */
  | { kind: "values"; values: OrganizationVariableValues }
  /** The opamp-server holds no such organization, so it has no variables: every reference stays as written. */
  | { kind: "none" }
  /** They couldn't be read; `reason` is the client's, an id-free word that may be logged. */
  | { kind: "unavailable"; reason: string };

/** Where a run's organization variables come from (ADR 0020's interface): the opamp-server in production. */
export interface IOrganizationVariables {
  /** The organization's own values, as every collector without a variable group would get them. */
  read(organizationId: string): Promise<OrganizationVariablesRead>;
}

/**
 * The opamp-server's variables, through its client's listVariables: listed,
 * the organization's values; `organization_not_found`, none; a refusal of
 * the request (400) or no answer, unavailable.
 */
export function opampOrganizationVariables(client: Pick<OpampServerClient, "listVariables">): IOrganizationVariables {
  return {
    async read(organizationId) {
      const result = await client.listVariables(organizationId);
      switch (result.kind) {
        case "listed":
          return { kind: "values", values: new Map(result.variables.map((variable) => [variable.name, variable.value])) };
        case "organization_not_found":
          return { kind: "none" };
        case "invalid":
          return { kind: "unavailable", reason: result.code };
        case "unavailable":
          return { kind: "unavailable", reason: result.reason };
      }
    },
  };
}

/** A run's text with the organization's values, measured against the longest text a run may have. */
export type RunTextFillIn =
  /** The text the tester gets: the run's own when it holds no live reference. */
  | { kind: "filled"; text: string }
  /** Longer than the limit once filled in: never built. */
  | { kind: "too_long" }
  | { kind: "unavailable"; reason: string };

/**
 * `text` filled in with the organization's values, read only when it holds
 * a live reference, its length counted before anything is built
 * (Preflight ruling 12) and refused over `maximumLength` code units.
 * `build` false measures only (the queue): `filled` then carries `text` as
 * it is.
 */
export async function fillInRunText(
  source: IOrganizationVariables,
  organizationId: string,
  text: string,
  options: { maximumLength: number; build: boolean },
): Promise<RunTextFillIn> {
  // No live reference: nothing to read, nothing to fill in.
  if (references(text).length === 0) return { kind: "filled", text };
  const read = await source.read(organizationId);
  if (read.kind === "unavailable") return read;
  const values = read.kind === "values" ? read.values : NO_VALUES;
  if (renderedLength(text, values).length > options.maximumLength) return { kind: "too_long" };
  return { kind: "filled", text: options.build ? render(text, values) : text };
}
