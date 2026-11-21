import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

import { PARSE_OPTIONS } from "~/lib/graph/parse.js";

/** Where Monaco's cursor goes: 1-based, as Monaco counts. */
export interface EditorPosition {
  lineNumber: number;
  column: number;
}

/**
 * Where each of the collector's component paths is in a text, for the status
 * bar's rows that jump. The text is the one on screen, parsed once here with a
 * `LineCounter` (never the store's document, which in manual edit mode is the
 * text from before the typing).
 *
 * A path is `::`-separated, with the whole id kept (`exporters::otlp/2`,
 * `service::pipelines::traces/2`). It is walked through the text's mappings
 * by exact key; the row jumps to the key of the deepest prefix that names
 * one, at least `<section>::<id>`: in
 * `receivers::filelog::baseconfig::operators::0::builder` `baseconfig` is a
 * Go struct, not a key, so it jumps to `filelog` under `receivers`. A path
 * naming nothing in the text (or no path, or a section alone) has no
 * position: the row is plain text.
 */
export function componentPositions(text: string): (componentPath: string | null) => EditorPosition | null {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  return (componentPath) => {
    if (componentPath === null) return null;
    let node: unknown = document.contents;
    let deepest: { offset: number; depth: number } | null = null;
    let depth = 0;
    for (const segment of componentPath.split("::")) {
      if (!isMap(node)) break;
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === segment);
      if (pair === undefined || !isScalar(pair.key) || pair.key.range == null) break;
      depth += 1;
      deepest = { offset: pair.key.range[0], depth };
      node = pair.value;
    }
    if (deepest === null || deepest.depth < 2) return null;
    const { line, col } = lineCounter.linePos(deepest.offset);
    return { lineNumber: line, column: col };
  };
}
