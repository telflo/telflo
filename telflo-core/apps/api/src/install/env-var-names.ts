import { INSTALL_ENV_NAME_MAXIMUM_LENGTH, RESERVED_INSTALL_ENV_NAMES } from "@telflo/contracts";

/*
 * The environment variables a published version's YAML needs at run time:
 * every `${env:NAME}` without a `:-default`, first appearance first, each
 * once, the five an install sets itself left out. A reference escaped as
 * `$${env:NAME}` (the collector reads `$$` as a literal `$`) needs nothing: an
 * odd run of `$` before the `{` is a reference, an even one is text. A name
 * over 256 characters is left out (the facts' reply bounds each name: one
 * longer would answer 500; the dialog can't offer it). The YAML is
 * configuration text: nothing here logs it.
 */

const RESERVED: ReadonlySet<string> = new Set(RESERVED_INSTALL_ENV_NAMES);

/** `${env:NAME}` and `${env:NAME:-default}`, with the run of `$` before it. */
const ENV_REFERENCE = /(\$+)\{env:([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

export function requiredEnvVarNames(yaml: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of yaml.matchAll(ENV_REFERENCE)) {
    const [, dollars, name, fallback] = match as unknown as [string, string, string, string | undefined];
    if (dollars.length % 2 === 0) continue;
    if (fallback !== undefined || RESERVED.has(name) || seen.has(name) || name.length > INSTALL_ENV_NAME_MAXIMUM_LENGTH) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
