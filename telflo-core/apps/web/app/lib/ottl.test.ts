import { describe, expect, it } from "vitest";

import { ottlString } from "./ottl.js";
import { findPattern } from "./regex-library.js";

/*
 * The OTTL string helper (D9d decision 12): the T2 template ("Redact
 * Passwords in URLs") built with it gives the template's statements
 * exactly.
 */

describe("ottlString", () => {
  it("reproduces the T2 template's statements from the regex library", () => {
    const url = `replace_pattern(span.attributes["http.url"], ${ottlString(findPattern("Password in URL Query").pattern)}, "password=***")`;
    const commandLine = `replace_pattern(span.attributes["process.command_line"], ${ottlString(
      findPattern("Password in Command Line").pattern,
    )}, "password=***")`;
    // The template's own literals, character for character.
    expect(url).toBe(`replace_pattern(span.attributes["http.url"], "password=([^&]+)", "password=***")`);
    expect(commandLine).toBe(String.raw`replace_pattern(span.attributes["process.command_line"], "password\\=([^\\s]*)", "password=***")`);
  });

  it("escapes a backslash and a double quote, and nothing else", () => {
    expect(ottlString("")).toBe('""');
    expect(ottlString(String.raw`a\d"b'c`)).toBe(String.raw`"a\\d\"b'c"`);
    expect(ottlString("line\nbreak")).toBe('"line\nbreak"');
  });
});
