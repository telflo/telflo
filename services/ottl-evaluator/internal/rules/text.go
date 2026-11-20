// The text rules' whitespace-tolerant matcher, and the byte-bounded cuts
// every shown text gets.

package rules

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/telflo/ottl-evaluator/pkg/ottlassert"
)

// work counts what a matcher or a scan has done and calls its checkpoint
// every checkEveryCandidates candidate positions and every checkEveryBytes
// bytes scanned.
type work struct {
	check      ottlassert.Checkpoint
	candidates int
	bytes      int
}

func newWork(check ottlassert.Checkpoint) *work {
	if check == nil {
		check = func() error { return nil }
	}
	return &work{check: check}
}

func (w *work) candidate() error {
	w.candidates++
	if w.candidates%checkEveryCandidates == 0 {
		return w.check()
	}
	return nil
}

func (w *work) scanned(n int) error {
	w.bytes += n
	for w.bytes >= checkEveryBytes {
		w.bytes -= checkEveryBytes
		if err := w.check(); err != nil {
			return err
		}
	}
	return nil
}

// textPattern is a text rule's text split at its whitespace (Go's
// unicode.IsSpace, the no-break space included; a JSON escape such as \n is
// two characters, not whitespace). Leading and trailing whitespace is
// ignored; a text of only whitespace has no tokens.
type textPattern struct {
	tokens [][]byte
}

func newTextPattern(text string) textPattern {
	fields := strings.Fields(text)
	tokens := make([][]byte, len(fields))
	for i, field := range fields {
		tokens[i] = []byte(field)
	}
	return textPattern{tokens: tokens}
}

func (p textPattern) empty() bool { return len(p.tokens) == 0 }

// find returns the leftmost match at or after from: the tokens in order,
// each byte for byte (case-sensitive), with any run of whitespace, or none,
// between them. A match never includes whitespace before its first token or
// after its last.
func (p textPattern) find(h []byte, from int, w *work) (start, end int, found bool, err error) {
	first := p.tokens[0]
	pos := from
	for pos <= len(h) {
		i := bytes.Index(h[pos:], first)
		if i < 0 {
			return 0, 0, false, w.scanned(len(h) - pos)
		}
		if err := w.scanned(i); err != nil {
			return 0, 0, false, err
		}
		s := pos + i
		if err := w.candidate(); err != nil {
			return 0, 0, false, err
		}
		e, ok, err := p.verify(h, s+len(first), w)
		if err != nil {
			return 0, 0, false, err
		}
		if ok {
			return s, e, true, nil
		}
		pos = s + 1
	}
	return 0, 0, false, nil
}

// verify checks the tokens after the first from position at, returning
// where the match ends.
func (p textPattern) verify(h []byte, at int, w *work) (int, bool, error) {
	e := at
	for _, token := range p.tokens[1:] {
		e = skipSpace(h, e)
		if !bytes.HasPrefix(h[e:], token) {
			return 0, false, w.scanned(e - at)
		}
		e += len(token)
	}
	return e, true, w.scanned(e - at)
}

// skipSpace returns the first position at or after i that isn't
// whitespace.
func skipSpace(h []byte, i int) int {
	for i < len(h) {
		c := h[i]
		if c < utf8.RuneSelf {
			if c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' {
				i++
				continue
			}
			return i
		}
		r, size := utf8.DecodeRune(h[i:])
		if !unicode.IsSpace(r) {
			return i
		}
		i += size
	}
	return i
}

// findAll returns the leftmost non-overlapping matches, at most limit of
// them.
func (p textPattern) findAll(h []byte, limit int, w *work) ([][2]int, error) {
	var spans [][2]int
	pos := 0
	for len(spans) < limit {
		s, e, found, err := p.find(h, pos, w)
		if err != nil {
			return nil, err
		}
		if !found {
			break
		}
		spans = append(spans, [2]int{s, e})
		pos = e
	}
	return spans, nil
}

// isBlank says whether s holds nothing but whitespace.
func isBlank(s string) bool {
	return strings.TrimFunc(s, unicode.IsSpace) == ""
}

// cutBytes cuts s to at most limit bytes on a rune boundary, saying
// whether it cut anything.
func cutBytes(s []byte, limit int) ([]byte, bool) {
	if len(s) <= limit {
		return s, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// capMessage cuts a message to maxMessageBytes, "…" included.
func capMessage(s string) string {
	if len(s) <= maxMessageBytes {
		return s
	}
	cut, _ := cutBytes([]byte(s), maxMessageBytes-len("…"))
	return string(cut) + "…"
}

// matchAt builds a shown match for h[s:e]: its text (at most
// maxMatchTextBytes) and up to contextBytes on each side, never crossing a
// newline, on rune boundaries. Its record is filled in by the caller.
func matchAt(h []byte, s, e int) Match {
	text, truncated := cutBytes(h[s:e], maxMatchTextBytes)

	from := max(s-contextBytes, 0)
	if nl := bytes.LastIndexByte(h[from:s], '\n'); nl >= 0 {
		from += nl + 1
	}
	for from < s && !utf8.RuneStart(h[from]) {
		from++
	}

	to := min(e+contextBytes, len(h))
	if nl := bytes.IndexByte(h[e:to], '\n'); nl >= 0 {
		to = e + nl
	}
	for to > e && to < len(h) && !utf8.RuneStart(h[to]) {
		to--
	}
	return Match{
		Text:          string(text),
		TextTruncated: truncated,
		Before:        string(h[from:s]),
		After:         string(h[e:to]),
	}
}

// countRunes counts h's characters (an invalid byte counts as one), calling
// the checkpoint as it goes.
func countRunes(h []byte, w *work) (int, error) {
	n := 0
	for i := 0; i < len(h); {
		end := min(i+checkEveryBytes, len(h))
		for end < len(h) && end > i && !utf8.RuneStart(h[end]) {
			end--
		}
		if end == i {
			end = min(i+checkEveryBytes, len(h))
		}
		n += utf8.RuneCount(h[i:end])
		if err := w.scanned(end - i); err != nil {
			return 0, err
		}
		i = end
	}
	return n, nil
}

// lineNumbers returns the line, from 1, each span starts on; spans are in
// order.
func lineNumbers(h []byte, spans [][2]int, w *work) ([]int, error) {
	lines := make([]int, len(spans))
	line, pos := 1, 0
	for i, span := range spans {
		for pos < span[0] {
			end := min(pos+checkEveryBytes, span[0])
			line += bytes.Count(h[pos:end], []byte{'\n'})
			if err := w.scanned(end - pos); err != nil {
				return nil, err
			}
			pos = end
		}
		lines[i] = line
	}
	return lines, nil
}
