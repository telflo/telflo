import { parseDocument } from "yaml";

/*
 * The pipeline names a collector configuration's text declares: the keys of
 * its `service.pipelines` mapping. The public API's only reading of a
 * configuration's structure for a pipeline: the validation pipelines' PUT
 * checks the name in its path against the version's text, and a test run
 * its `pipeline` against its text. Whether the components are valid stays
 * the validator's.
 *
 * Read as the flows' lint and the OTTL lint read a configuration (the core
 * schema, merge keys, unique keys, at most 100 aliases). A text that
 * doesn't parse, or has no `service.pipelines` mapping, declares no
 * pipeline. Nothing here logs or throws the text or the parser's words: a
 * caller answers in fixed words.
 */

/** As the flows' lint and the OTTL lint read a configuration: the core schema, merge keys, unique keys, no warning passed on. */
const PARSE_OPTIONS = { merge: true, prettyErrors: false, uniqueKeys: true, logLevel: "error" } as const;

/** How many aliases one text may resolve before it is refused as an alias bomb (`yaml`'s default). */
const MAXIMUM_ALIAS_COUNT = 100;

/**
 * The keys of the text's `service.pipelines` mapping, in the text's order,
 * or undefined when the text doesn't parse (a syntax error, a duplicate key,
 * an alias bomb) or holds no such mapping. A key that isn't a string (`1:`,
 * `true:`, `~:`) names no pipeline: the collector's pipeline ids are
 * `signal[/name]` strings.
 */
export function pipelineKeysOf(text: string): string[] | undefined {
  let config: unknown;
  try {
    const document = parseDocument(text, PARSE_OPTIONS);
    if (document.errors.length > 0) return undefined;
    config = document.toJS({ mapAsMap: true, maxAliasCount: MAXIMUM_ALIAS_COUNT });
  } catch {
    return undefined;
  }
  if (!(config instanceof Map)) return undefined;
  const service: unknown = config.get("service");
  if (!(service instanceof Map)) return undefined;
  const pipelines: unknown = service.get("pipelines");
  if (!(pipelines instanceof Map)) return undefined;
  return [...pipelines.keys()].filter((key): key is string => typeof key === "string");
}

/** Whether `pipeline` is a key of the text's `service.pipelines`: false for a text that declares none. */
export function hasPipelineKey(text: string, pipeline: string): boolean {
  return pipelineKeysOf(text)?.includes(pipeline) ?? false;
}
