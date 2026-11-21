/*
 * Ids as the API compares them: the API's own `canonicalIdOf`
 * (`organizations/service.ts`), copied because the CLI imports nothing
 * from a workspace at run time. Every id typed or stored goes through it
 * before it's compared or sent.
 */

import { EXIT, ExitError } from "./output.js";

/** A UUID in its canonical, hyphenated form, in either case. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id lowercased, or undefined when it isn't a canonical hyphenated UUID (no braces, no missing hyphens). */
export function canonicalIdOf(id: string): string | undefined {
  return CANONICAL_UUID.test(id) ? id.toLowerCase() : undefined;
}

/** The id canonicalized, or a usage error (exit 2) naming what it was meant to be: never the text typed. */
export function requireId(id: string, what: string): string {
  const canonical = canonicalIdOf(id.trim());
  if (canonical === undefined) throw new ExitError(`The ${what} must be an id (a UUID).`, EXIT.USAGE);
  return canonical;
}
