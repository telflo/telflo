package ottlassert

// Letters where an OTTL-level escape (odd backslash run) diverges from the
// regex-class meaning the author almost certainly intended. \n/\t/\r are
// excluded: their control characters match the same text the regex escapes
// would, so flagging them would be a false positive.
var riskyEscapeLetters = map[byte]bool{
	'b': true, 'B': true,
	'd': true, 'D': true,
	'w': true, 'W': true,
	's': true, 'S': true,
	'A': true, 'z': true, 'Z': true,
}

// findSuspiciousEscape returns the single-escaped regex metachar sequence
// (e.g. `\b`) contained in expr, or "" when none is present.
//
// OTTL string literals consume one level of backslash escaping, so a
// condition written as IsMatch(body.string, "\b[0-9]+\b") hands the regex
// engine a literal BACKSPACE character — the pattern can never match, and a
// `not IsMatch(...)` assertion passes against anything (observed live: a
// redaction test suite went green while unredacted card numbers sat in the
// output). The regex form requires double backslashes: "\\b". An odd-length
// backslash run followed by a metachar letter means the final backslash is
// an OTTL-level escape — virtually always this mistake. Scanning bytes is
// safe: 0x5C never appears inside a UTF-8 multi-byte sequence.
func findSuspiciousEscape(expr string) string {
	i := 0
	n := len(expr)
	for i < n {
		if expr[i] != '\\' {
			i++
			continue
		}
		j := i
		for j < n && expr[j] == '\\' {
			j++
		}
		run := j - i
		if j < n && run%2 == 1 && riskyEscapeLetters[expr[j]] {
			return "\\" + string(expr[j])
		}
		// Skip the character the run escapes (if any) so e.g. \" advances
		// past the quote before the next scan.
		if j < n && run%2 == 1 {
			i = j + 1
		} else {
			i = j
		}
	}
	return ""
}

// suspiciousEscapeError words the mistake for its sequence. OTTL unquotes a
// string literal as Go does (participle's Unquote, strconv.UnquoteChar):
// `\b` is Go's backspace escape, so it parses and can never match; every
// other risky letter (`\d`, `\w`, `\s`, …) is no Go escape at all, so the
// literal doesn't parse.
func suspiciousEscapeError(sequence string) string {
	letter := sequence[len(sequence)-1:]
	if letter == "b" {
		return "single-escaped regex sequence '\\b': OTTL string literals consume " +
			"one level of backslash escaping, so it becomes a literal backspace " +
			"character and the pattern can never match — write '\\\\b' (double " +
			"backslash) for the regex word boundary"
	}
	return "single-escaped regex sequence '" + sequence + "': it isn't an OTTL " +
		"string escape (OTTL string literals consume one level of backslash " +
		"escaping), so the regex needs a double backslash — write '\\\\" + letter + "'"
}
