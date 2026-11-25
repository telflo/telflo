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

/*
 * Linear in the text's length, whatever it holds (it is a member's stored
 * YAML, up to 256 KiB, read on the API's event loop). The one pattern
 * `(\$+)\{env:NAME(:-[^}]*)?\}` found the same references but cost the
 * square of the length twice over: `\$+` was tried again from every dollar
 * of a long run, and `[^}]*` ran to the end of the text from every
 * `${env:A:-` when no `}` followed. Here a match starts only at a run's first
 * dollar (from any later one, `\$+` meets the same `{env:` or not), the
 * pattern stops at the name and what follows it, and a `:-default` is
 * skipped to its first `}` with one indexOf, as `[^}]*\}` matched it; with
 * no `}` after it, no later reference can close either.
 */
const ENV_REFERENCE_HEAD = /(?<!\$)(\$+)\{env:([A-Za-z_][A-Za-z0-9_]*)(\}|:-)/g;

export function requiredEnvVarNames(yaml: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const head = new RegExp(ENV_REFERENCE_HEAD);
  for (let match = head.exec(yaml); match !== null; match = head.exec(yaml)) {
    const [, dollars, name, after] = match as unknown as [string, string, string, "}" | ":-"];
    if (after === ":-") {
      // A default: no name needed, and nothing up to its closing brace is read.
      const close = yaml.indexOf("}", head.lastIndex);
      if (close === -1) break;
      head.lastIndex = close + 1;
      continue;
    }
    if (dollars.length % 2 === 0) continue;
    if (RESERVED.has(name) || seen.has(name) || name.length > INSTALL_ENV_NAME_MAXIMUM_LENGTH) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
