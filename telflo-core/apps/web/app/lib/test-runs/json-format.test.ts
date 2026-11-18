import { describe, expect, it } from "vitest";
import { decodeFileText, parseJsonText, prettyPrint, prettyPrintParsed, splitTopLevelJsonDocs, toCanonicalFormat } from "./json-format.js";

/* The JSON formatting for Task 10's viewers: how it reads, and puts back, a file's JSON. */

describe("prettyPrint", () => {
  it("indents one document by two", () => {
    expect(prettyPrint(' {"a":[1,{"b":2}]} ')).toEqual({ display: '{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}', format: "single" });
  });

  it("indents each NDJSON line's document, a blank line between them", () => {
    expect(prettyPrint('{"a":1}\n\n{"b":2}\n')).toEqual({ display: '{\n  "a": 1\n}\n\n{\n  "b": 2\n}', format: "ndjson" });
  });

  it("leaves anything else (and nothing) as it is", () => {
    expect(prettyPrint("plain\ntext")).toEqual({ display: "plain\ntext", format: "raw" });
    expect(prettyPrint('{"a":1}\nnot json')).toEqual({ display: '{"a":1}\nnot json', format: "raw" });
    expect(prettyPrint("  \n ")).toEqual({ display: "", format: "raw" });
  });
});

describe("parseJsonText and prettyPrintParsed (Compare's one parse, D15b Preflight ruling 8)", () => {
  it("reads one document, NDJSON's documents (blank lines skipped), or neither", () => {
    expect(parseJsonText(' [1,{"b":2}] ')).toEqual({ format: "single", document: [1, { b: 2 }] });
    expect(parseJsonText('{"a":1}\r\n\n{"b":2}\n')).toEqual({ format: "ndjson", documents: [{ a: 1 }, { b: 2 }] });
    expect(parseJsonText('{"a":1}\nnot json')).toEqual({ format: "raw" });
    expect(parseJsonText(" \n ")).toEqual({ format: "raw" });
  });

  it("prints from the parsed value exactly what prettyPrint prints", () => {
    for (const text of [' {"a":[1,{"b":2}]} ', '{"a":1}\n\n{"b":2}\n', "plain\ntext", '{"a":1}\nnot json', "  \n ", '"zq"', "[]"]) {
      expect(prettyPrintParsed(parseJsonText(text), text)).toEqual(prettyPrint(text));
    }
  });
});

describe("splitTopLevelJsonDocs", () => {
  it("finds each top-level document, strings with braces and escapes included", () => {
    expect(splitTopLevelJsonDocs('{"a":"}{\\""}  [1,[2]]\n{"b":{}}')).toEqual(['{"a":"}{\\""}', "[1,[2]]", '{"b":{}}']);
  });

  it("is null for an unclosed string or mismatched braces", () => {
    expect(splitTopLevelJsonDocs('{"a":"open}')).toBeNull();
    expect(splitTopLevelJsonDocs('{"a":1}}')).toBeNull();
    expect(splitTopLevelJsonDocs('{"a":1')).toBeNull();
  });
});

describe("toCanonicalFormat", () => {
  it("puts a pretty view back as compact JSON, or one compact document a line", () => {
    expect(toCanonicalFormat('{\n  "a": 1\n}', "single")).toBe('{"a":1}');
    expect(toCanonicalFormat('{\n  "a": 1\n}\n\n{\n  "b": 2\n}', "ndjson")).toBe('{"a":1}\n{"b":2}');
  });

  it("leaves raw text, and edits that broke the JSON, unchanged", () => {
    expect(toCanonicalFormat("raw {", "raw")).toBe("raw {");
    expect(toCanonicalFormat('{"a": }', "single")).toBe('{"a": }');
    expect(toCanonicalFormat('{"a": 1', "ndjson")).toBe('{"a": 1');
  });
});

describe("decodeFileText (a viewer's text from a file's bytes)", () => {
  it("reads UTF-8, dropping its byte-order mark", () => {
    expect(decodeFileText(new TextEncoder().encode('{"é":1}'))).toBe('{"é":1}');
    expect(decodeFileText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("reads UTF-16 in either byte order by its byte-order mark", () => {
    expect(decodeFileText(new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]))).toBe("{}");
    expect(decodeFileText(new Uint8Array([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]))).toBe("{}");
  });

  it("shows bytes that aren't UTF-8 as U+FFFD, refusing nothing; no bytes are no text", () => {
    expect(decodeFileText(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(decodeFileText(new Uint8Array([]))).toBe("");
  });
});
