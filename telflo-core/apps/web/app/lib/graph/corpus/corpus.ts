/*
 * The corpus: configurations the builder must read and write back
 * faithfully. The starter; the configurations the builder's tests build
 * (`test/pipeline-builder.ts`, complex-config, the routing, failover and
 * forward connectors, service.telemetry), as generated or as typed; and
 * hand-written cases for the parser's rules, anchors and merges, unknown
 * components and keys, comments, renamed types, numbers and CRLF line
 * endings; and the layouts the text edits must keep: four-space
 * indentation, sequences at their key's column, folded blocks and key-line
 * comments, flow mappings, no final line break, and anchors components own;
 * and the lists of mappings and scalars that forms edit by item, and list
 * items that own anchors other components alias; and the form families
 * (`forms-kubernetes.yaml`, `forms-host.yaml` with CRLF,
 * `forms-logs-operators.yaml`), each with comments, an anchor, `0750` and
 * its pipelines, and more of them (`forms-metrics.yaml`,
 * `forms-traces.yaml`, `forms-ottl.yaml`, `forms-routing.yaml` with CRLF,
 * `forms-storage.yaml`, `forms-vendors.yaml` with CRLF), each with comments,
 * an anchor, CRLF or `0750`, and its pipelines, every routing and failover
 * target listing its connector in its receivers; and
 * `routing-inconsistent.yaml` (with CRLF), whose receivers and routing and
 * failover configs disagree both ways; and `flow-spread.yaml` (with CRLF),
 * flow sequences spread over lines in pipelines and components, with
 * comments on items, trailing commas and a comma on its own line.
 *
 * Test data only. `.gitattributes` keeps every file's bytes as they are
 * (crlf.yaml's line endings).
 */

const files = import.meta.glob<string>("./*.yaml", { query: "?raw", import: "default", eager: true });

export interface CorpusText {
  /** The file's name, e.g. `starter.yaml`. */
  name: string;
  text: string;
}

export const CORPUS: readonly CorpusText[] = Object.entries(files)
  .map(([path, text]) => ({ name: path.replace(/^\.\//, ""), text }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** One corpus text by file name. */
export function corpusText(name: string): string {
  const found = CORPUS.find((entry) => entry.name === name);
  if (!found) throw new Error(`No corpus file ${name}`);
  return found.text;
}
