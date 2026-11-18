/*
 * Pretty-printing a test file's JSON or NDJSON for a viewer, and putting an
 * edited pretty view back into the file's own form for Copy (D14a Task 10's
 * viewers use it). Its `prettyPrint` is split in two, the reading
 * (`parseJsonText`) and the printing (`prettyPrintParsed`), so Compare parses
 * each file once (D15b).
 */

/** How a text was read: one JSON document, NDJSON (one document a line), or neither. */
export type JsonFormat = "single" | "ndjson" | "raw";

/**
 * A text read as JSON, once: one document, NDJSON's documents (one a line,
 * blank lines skipped), or neither (`raw`, an empty text included). Compare
 * reads each file once and both pretty-prints and detects from what this
 * gives (D15b Preflight ruling 8).
 */
export type ParsedJsonText = { format: "single"; document: unknown } | { format: "ndjson"; documents: unknown[] } | { format: "raw" };

/** `text` read as JSON (ParsedJsonText): one document, else NDJSON, else neither. */
export function parseJsonText(text: string): ParsedJsonText {
  const trimmed = text.trim();
  if (!trimmed) return { format: "raw" };

  try {
    return { format: "single", document: JSON.parse(trimmed) };
  } catch {
    // Not one document: NDJSON, perhaps.
  }

  const documents: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      documents.push(JSON.parse(line));
    } catch {
      return { format: "raw" };
    }
  }
  return documents.length > 0 ? { format: "ndjson", documents } : { format: "raw" };
}

/** `parsed` (parseJsonText's of `text`) indented for reading, as prettyPrint, from the parsed value: nothing is parsed again. */
export function prettyPrintParsed(parsed: ParsedJsonText, text: string): { display: string; format: JsonFormat } {
  switch (parsed.format) {
    case "single":
      return { display: JSON.stringify(parsed.document, null, 2), format: "single" };
    case "ndjson":
      return { display: parsed.documents.map((document) => JSON.stringify(document, null, 2)).join("\n\n"), format: "ndjson" };
    default:
      return { display: text.trim() ? text : "", format: "raw" };
  }
}

/**
 * `text` indented for reading, and how it was read: one JSON document
 * indented by two; NDJSON with each line's document indented, a blank line
 * between them; anything else (or empty) as it is.
 */
export function prettyPrint(text: string): { display: string; format: JsonFormat } {
  return prettyPrintParsed(parseJsonText(text), text);
}

/**
 * The top-level JSON documents in `text`, by tracking brace and bracket depth
 * and string state, whatever whitespace lies between them (it survives a
 * reformatted pretty view); null when the structure is malformed (an
 * unclosed string, mismatched braces).
 */
export function splitTopLevelJsonDocs(text: string): string[] | null {
  const documents: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === "\\") {
        escape = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      if (depth === 0) start = index;
      depth++;
      continue;
    }

    if (character === "}" || character === "]") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0 && start >= 0) {
        documents.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  if (depth !== 0 || inString) return null;
  return documents;
}

/**
 * A (perhaps edited) pretty view put back into the file's own form: compact
 * JSON for one document, one compact document a line for NDJSON. Text whose
 * edits broke the JSON comes back unchanged, so it can still be copied.
 */
export function toCanonicalFormat(text: string, format: JsonFormat): string {
  if (format === "raw") return text;

  const documents = splitTopLevelJsonDocs(text);
  if (documents === null) return text;

  const compact: string[] = [];
  for (const document of documents) {
    try {
      compact.push(JSON.stringify(JSON.parse(document)));
    } catch {
      return text;
    }
  }

  return format === "single" ? compact.join("") : compact.join("\n");
}

/**
 * A test file's bytes as text, for a viewer (D14a Preflight ruling 14: the
 * bytes arrive undecoded): UTF-16 (either order) or UTF-8 by its byte-order
 * mark, which is dropped, else UTF-8. A byte that isn't valid shows as
 * U+FFFD; nothing is refused.
 */
export function decodeFileText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // TextDecoder drops a UTF-8 byte-order mark itself.
  return new TextDecoder("utf-8").decode(bytes);
}
