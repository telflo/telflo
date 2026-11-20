// Linear scans of the output's JSON. One finds the output's shape once per
// request (how many objects it holds, for the OTTL cap; whether it is the
// tester's `{"records":[…]}` wrapper, and where each record is); the other
// names the record and the JSON path of each shown match, instead of a line
// and column. Both call their checkpoint every checkEveryBytes bytes. Neither
// decodes a string or a number: they only follow the structure.

package rules

import (
	"bytes"
	"strconv"
	"unicode/utf8"
)

// maxScanDepth bounds the structure the locating scan follows; past it,
// matches get no record (an OTLP document nests about ten deep).
const maxScanDepth = 1000

// facts are what one scan of the output finds.
type facts struct {
	// objects counts the JSON objects ('{' outside strings).
	objects int
	// wellFormed: every bracket closes the one it should, no string is left
	// open, and every top-level value is an object or an array.
	wellFormed bool
	// wrapped: the output is one object whose only member is "records", an
	// array; records holds each element's span.
	wrapped bool
	records [][2]int
}

// scanFacts reads the output once.
func scanFacts(h []byte, w *work) (facts, error) {
	var f facts
	var stack []byte // the open brackets
	inString, escaped := false, false
	roots := 0
	badRoot := false
	// The wrapper: the root object's members, its first key, whether that
	// key's value is an array, and the spans of that array's elements.
	rootMembers := 0
	expectKey := false // at depth 1 of a root object, the next string is a key
	keyStart := -1     // where the current depth-1 key's text starts
	firstKeyRecords := false
	firstValueArray := false
	inRecords := false // inside the first member's array, at depth 2
	elementStart := -1 // where the current element of records starts
	chunk := 0

	for i := 0; i < len(h); i++ {
		chunk++
		if chunk == checkEveryBytes {
			chunk = 0
			if err := w.scanned(checkEveryBytes); err != nil {
				return facts{}, err
			}
		}
		c := h[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
				if keyStart >= 0 {
					if rootMembers == 1 && string(h[keyStart:i]) == "records" {
						firstKeyRecords = true
					}
					keyStart = -1
				}
			}
			continue
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		depth := len(stack)
		// An element of the records array starts at its first byte.
		if inRecords && depth == 2 && elementStart < 0 && c != ',' && c != ']' {
			elementStart = i
		}
		switch c {
		case '{', '[':
			if depth == 0 {
				roots++
			}
			if depth == 1 && stack[0] == '{' && rootMembers == 1 && !expectKey && c == '[' && firstKeyRecords {
				firstValueArray = true
				inRecords = true
			}
			if c == '{' {
				f.objects++
			}
			stack = append(stack, c)
			if len(stack) == 1 && c == '{' {
				expectKey = true
			}
		case '}', ']':
			if depth == 0 || (c == '}') != (stack[depth-1] == '{') {
				return f, nil // not well formed: nothing more to learn
			}
			if inRecords && depth == 2 {
				if elementStart >= 0 {
					f.records = append(f.records, [2]int{elementStart, elementEnd(h, i)})
					elementStart = -1
				}
				inRecords = false
			}
			stack = stack[:depth-1]
		case '"':
			if depth == 0 {
				roots++
				badRoot = true
			}
			inString = true
			if depth == 1 && stack[0] == '{' && expectKey {
				rootMembers++
				keyStart = i + 1
				expectKey = false
			}
		case ':':
		case ',':
			if depth == 1 && stack[0] == '{' {
				expectKey = true
			}
			if inRecords && depth == 2 && elementStart >= 0 {
				f.records = append(f.records, [2]int{elementStart, elementEnd(h, i)})
				elementStart = -1
			}
		default:
			if depth == 0 {
				// A top-level scalar: not an OTLP document.
				badRoot = true
				for i+1 < len(h) && !isDelimiter(h[i+1]) {
					i++
				}
				roots++
			}
		}
	}
	if err := w.scanned(chunk); err != nil {
		return facts{}, err
	}
	f.wellFormed = len(stack) == 0 && !inString && roots > 0 && !badRoot
	f.wrapped = f.wellFormed && roots == 1 && rootMembers == 1 && firstKeyRecords && firstValueArray
	if !f.wrapped {
		f.records = nil
	}
	return f, nil
}

// elementEnd is the end of the element before the comma or bracket at i,
// with whitespace before it left out.
func elementEnd(h []byte, i int) int {
	end := i
	for end > 0 && isSpace(h[end-1]) {
		end--
	}
	return end
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func isDelimiter(c byte) bool {
	return isSpace(c) || c == ',' || c == ':' || c == '{' || c == '}' || c == '[' || c == ']' || c == '"'
}

// segment is one step of a JSON path: a member's key (its raw text between
// the quotes) or an element's index.
type segment struct {
	key     []byte
	index   int
	isIndex bool
}

// locFrame is an open object or array.
type locFrame struct {
	object    bool
	seg       segment // how the frame is reached from its parent
	key       []byte  // an object's current member's key
	expectKey bool
	index     int // an array's current element
}

// snapshot is what the scan knew at a match's start.
type snapshot struct {
	segs     []segment // the open frames' segments, outermost first
	leaf     *segment  // the string or scalar value holding the start
	leafEnd  int       // where that value ends (-1 until it does)
	minDepth int       // how few of the frames stayed open up to the end
}

// locateOutput names each span's record: spans are in order and don't
// overlap. wrapped says the output is the tester's {"records":[…]}.
func locateOutput(h []byte, spans [][2]int, wrapped bool, w *work) ([]OutputRecord, error) {
	records := make([]OutputRecord, len(spans))
	if len(spans) == 0 {
		return records, nil
	}
	var stack []locFrame
	roots := -1
	inString, escaped, keyString := false, false, false
	stringStart := -1
	inScalar := false
	var leaf *segment // the value now being read
	k := 0            // the span being located
	var snap *snapshot
	chunk := 0
	overflow := false

	parentSeg := func() segment {
		if len(stack) == 0 {
			return segment{index: roots, isIndex: true}
		}
		top := &stack[len(stack)-1]
		if top.object {
			return segment{key: top.key}
		}
		return segment{index: top.index, isIndex: true}
	}
	take := func() {
		segs := make([]segment, len(stack))
		for j, frame := range stack {
			segs[j] = frame.seg
		}
		snap = &snapshot{segs: segs, leafEnd: -1, minDepth: len(stack)}
		if leaf != nil {
			l := *leaf
			snap.leaf = &l
		}
	}
	endLeaf := func(at int) {
		if leaf != nil && snap != nil && snap.leaf != nil && snap.leafEnd < 0 {
			snap.leafEnd = at
		}
		leaf = nil
	}

	for i := 0; i < len(h) && k < len(spans); i++ {
		chunk++
		if chunk == checkEveryBytes {
			chunk = 0
			if err := w.scanned(checkEveryBytes); err != nil {
				return nil, err
			}
		}
		s, e := spans[k][0], spans[k][1]
		c := h[i]
		closing := !inString && (c == '}' || c == ']')
		if snap == nil && i == s && closing {
			take()
		}
		// Process byte i.
		if overflow {
			// Past maxScanDepth: no more records.
		} else if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
				if keyString {
					stack[len(stack)-1].key = h[stringStart+1 : i]
				} else {
					endLeaf(i)
				}
			}
		} else {
			if inScalar && isDelimiter(c) {
				inScalar = false
				endLeaf(i - 1)
			}
			switch c {
			case ' ', '\t', '\n', '\r':
			case '{', '[':
				seg := parentSeg()
				if len(stack) == 0 {
					roots++
					seg = segment{index: roots, isIndex: true}
				}
				stack = append(stack, locFrame{object: c == '{', seg: seg, expectKey: c == '{'})
				if len(stack) > maxScanDepth {
					overflow = true
				}
			case '}', ']':
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
					if snap != nil && i < e-1 {
						snap.minDepth = min(snap.minDepth, len(stack))
					}
				}
			case ':':
				if len(stack) > 0 && stack[len(stack)-1].object {
					stack[len(stack)-1].expectKey = false
				}
			case ',':
				if len(stack) > 0 {
					top := &stack[len(stack)-1]
					if top.object {
						top.expectKey = true
						top.key = nil
					} else {
						top.index++
					}
				}
			case '"':
				inString = true
				stringStart = i
				keyString = len(stack) > 0 && stack[len(stack)-1].object && stack[len(stack)-1].expectKey
				if !keyString {
					seg := parentSeg()
					if len(stack) == 0 {
						roots++
						seg = segment{index: roots, isIndex: true}
					}
					leaf = &seg
				}
			default:
				if !inScalar {
					inScalar = true
					seg := parentSeg()
					if len(stack) == 0 {
						roots++
						seg = segment{index: roots, isIndex: true}
					}
					leaf = &seg
				}
			}
		}
		if snap == nil && i == s {
			take()
		}
		// The span ends at e-1: what still holds it holds the whole match.
		for snap != nil && i >= e-1 {
			if overflow {
				records[k] = OutputRecord{}
			} else {
				records[k] = recordOf(snap, wrapped, e)
			}
			snap = nil
			k++
			if k == len(spans) {
				break
			}
			s, e = spans[k][0], spans[k][1]
			if i == s {
				// A span starting where the last ended can't happen
				// (matches don't overlap), but stay correct if it does.
				take()
			}
		}
	}
	if err := w.scanned(chunk); err != nil {
		return nil, err
	}
	return records, nil
}

// recordOf turns a match's snapshot into its record.
func recordOf(snap *snapshot, wrapped bool, e int) OutputRecord {
	// Everything that held the match's start, outermost first.
	atStart := append([]segment(nil), snap.segs...)
	leafHolds := snap.leaf != nil && (snap.leafEnd < 0 || snap.leafEnd >= e-1) && snap.minDepth == len(snap.segs)
	if snap.leaf != nil {
		atStart = append(atStart, *snap.leaf)
	}
	// What held the whole match.
	holding := append([]segment(nil), snap.segs[:snap.minDepth]...)
	if leafHolds {
		holding = append(holding, *snap.leaf)
	}

	// The record is the element of records (wrapped: root, records,
	// record) or the top-level value (unwrapped).
	recordDepth := 0
	if wrapped {
		recordDepth = 2
	}
	if len(atStart) <= recordDepth {
		return OutputRecord{}
	}
	index := atStart[recordDepth].index
	record := OutputRecord{Index: &index}
	if len(holding) > recordDepth+1 {
		record.Path = formatPath(holding[recordDepth+1:])
	}
	return record
}

// formatPath writes segments as a JSON path, such as
// resourceLogs[0].scopeLogs[0].logRecords[3].body.stringValue, keeping its
// last maxPathBytes bytes when it is longer.
func formatPath(segs []segment) string {
	var b bytes.Buffer
	for j, seg := range segs {
		switch {
		case seg.isIndex:
			b.WriteByte('[')
			b.WriteString(strconv.Itoa(seg.index))
			b.WriteByte(']')
		case isIdentifier(seg.key):
			if j > 0 {
				b.WriteByte('.')
			}
			b.Write(seg.key)
		default:
			// The key's raw text is already JSON-escaped.
			b.WriteString(`["`)
			b.Write(seg.key)
			b.WriteString(`"]`)
		}
	}
	path := b.Bytes()
	if len(path) <= maxPathBytes {
		return string(path)
	}
	tail := path[len(path)-(maxPathBytes-len("…")):]
	// Start the tail at a segment if one starts in it, else at a rune.
	if at := bytes.IndexAny(tail, ".["); at > 0 {
		tail = tail[at:]
	}
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return "…" + string(tail)
}

func isIdentifier(key []byte) bool {
	if len(key) == 0 {
		return false
	}
	for j, c := range key {
		letter := c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if !letter && (j == 0 || c < '0' || c > '9') {
			return false
		}
	}
	return true
}
