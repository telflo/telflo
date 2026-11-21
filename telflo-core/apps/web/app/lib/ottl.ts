/*
 * OTTL string literals: strings are written as typed. A template statement
 * that puts a value from the regex library inside an OTTL string writes it as
 * OTTL reads it: the grammar lexes a string as `"(\\.|[^\\"])*"` and unquotes
 * it Go-style (`pkg/ottl/grammar.go:588`, `pkg/ottl/parser.go:424` at contrib
 * v0.162.0), so a backslash and a double quote are escaped. A regex's `\=` is
 * then `\\=` in the statement, as the command-line template writes it;
 * unescaped, `\=` is an invalid escape and the collector refuses the
 * statement.
 */

/** `s` as an OTTL string literal: `"` + `s` with `\` and `"` escaped + `"`. */
export function ottlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
