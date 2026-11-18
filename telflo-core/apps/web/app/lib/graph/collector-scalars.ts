/*
 * How the collector reads a plain scalar (D9c Ruling 69). The text edits
 * decide what they may write plain by `yaml`'s reading (YAML 1.2's core
 * schema), but the collector decodes the text with yaml.v3, whose plain
 * scalars resolve more widely: `go.yaml.in/yaml/v3` v3.0.5, the module
 * core's `confmap` requires at v0.162.0 (`confmap/go.mod:17`; contrib's
 * receivers pull the same, e.g. `receiver/filelogreceiver/go.mod:74`), in
 * `resolve.go:126-265`:
 * - a table of fixed spellings (`resolve.go:47-66`): `true`, `True`,
 *   `TRUE`, `false`, …, `~`, `null`, `Null`, `NULL`, `.nan`, `.inf` and
 *   their signed and cased spellings, and `<<` (a merge);
 * - after a `.`, whatever Go's `strconv.ParseFloat` takes (`.5`,
 *   `.5e3`, and `.5_0`: it takes `_` between digits; `:173-178`);
 * - after a digit or a sign (`:180-259`): a timestamp (`parseTimestamp`,
 *   `:306-326`: four digits and `-`, then `2006-1-2`, with `T`, `t` or a
 *   space and a time; Go's `time.Parse` takes a comma before the
 *   fraction of a second, and any run of spaces where the layout has
 *   one), then, with every `_` taken out, Go's `strconv.ParseInt(…, 0,
 *   64)` or `ParseUint` (decimal, `0x`, `0o`, `0b` and a leading-zero
 *   octal, signed or not), `yamlStyleFloat` (`:124`), and `0b`, `-0b`,
 *   `0o`, `-0o`, whose digits `ParseInt` reads with a sign of their own
 *   (`0b-1`, `0o+7`; `:234`, `:246`).
 * So `1_000`, `0b101`, `-0x1F` and `2024-01-01` are strings to `yaml` and
 * a number or a time to the collector: a string written plain would reach
 * the collector as another type. `collectorReadsAsOther` says which plain
 * characters the collector doesn't read as a string, so the text edits
 * quote them. It errs toward quoting (a timestamp's fields aren't range-
 * checked, a number too large for 64 bits still counts): quoting a string
 * the collector would have read as one changes nothing it reads.
 */

/** yaml.v3's `resolveMap` (`resolve.go:47-66`): fixed spellings that aren't strings. */
const FIXED = new Set([
  "true",
  "True",
  "TRUE",
  "false",
  "False",
  "FALSE",
  "~",
  "null",
  "Null",
  "NULL",
  ".nan",
  ".NaN",
  ".NAN",
  ".inf",
  ".Inf",
  ".INF",
  "+.inf",
  "+.Inf",
  "+.INF",
  "-.inf",
  "-.Inf",
  "-.INF",
  "<<",
]);

/** Go's `strconv.ParseFloat` on characters starting with `.` (`resolve.go:173-178`), `_` between digits included. */
const DOT_FLOAT = /^\.[0-9](_?[0-9])*([eE][-+]?[0-9](_?[0-9])*)?$/;

/** yaml.v3's `allowedTimestampFormats` (`resolve.go:294-301`), their fields unchecked. */
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt][0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:[.,][0-9]*)?(?:Z|[-+][0-9]{2}:[0-9]{2})| +[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:[.,][0-9]*)?)?$/;

/** Go's `strconv.ParseInt(s, 0, 64)` syntax, and `ParseUint`'s (`resolve.go:191-203`), and the `0b`/`0o` forms (`:210-258`). */
const INTEGER = /^[-+]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$|^0b[-+][01]+$|^0o[-+][0-7]+$/;

/** yaml.v3's `yamlStyleFloat` (`resolve.go:124`). */
const FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** Whether the collector (yaml.v3) reads `text`, written as a plain scalar, as something other than a string. */
export function collectorReadsAsOther(text: string): boolean {
  if (FIXED.has(text)) return true;
  const first = text[0] ?? "";
  if (first === ".") return DOT_FLOAT.test(text);
  if (!/[-+0-9]/.test(first)) return false;
  if (TIMESTAMP.test(text)) return true;
  const plain = text.replaceAll("_", "");
  return INTEGER.test(plain) || FLOAT.test(plain);
}
