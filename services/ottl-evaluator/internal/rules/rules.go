// New in D15a Task 2 (spec decisions 2, 3, 8 and 11; plan Preflight rulings
// 5-10). Package rules checks a run's validation rules against its output
// and the collector's log: text rules (whitespace-tolerant, decision 8),
// regex rules (Go's regexp, RE2) and OTTL rules (pkg/ottlassert). It is the
// work the evaluator's child process does (child.go); the HTTP side, in
// internal/server, only checks a request's shape, runs the child under its
// limits and writes the answer. Every kind runs here (decision 2), with the
// answer's shapes of Preflight ruling 5.

package rules

import (
	"bytes"
	"encoding/json"
)

// The five kinds of rule (D15a decision 12). A request naming any other
// kind, a retired one included, is refused by its shape (400).
const (
	KindContainsText     = "contains_text"
	KindNotContainsText  = "not_contains_text"
	KindContainsRegex    = "contains_regex"
	KindNotContainsRegex = "not_contains_regex"
	KindOTTL             = "ottl"
)

// Kinds lists the five kinds.
var Kinds = []string{KindContainsText, KindNotContainsText, KindContainsRegex, KindNotContainsRegex, KindOTTL}

// What a text or regex rule searches: the stored output or the collector's
// log. OTTL rules read the output only.
const (
	TargetOutput = "output"
	TargetStderr = "stderr"
)

// The signals a run's output can carry.
var Signals = []string{"logs", "traces", "metrics"}

// The limits of Preflight rulings 5 and 10. The request's own caps (the
// body, the rule count) are internal/server's.
const (
	// MaxRules is how many rules one request may carry (D15a decision 13).
	MaxRules = 200
	// MaxTextBytes caps a pattern, a condition and an expression, in bytes
	// (the database counts them in bytes too, octet_length).
	MaxTextBytes = 8192
	// MaxNesting caps how deep (, [ and { nest in an OTTL text outside its
	// string literals: OTTL's parser is exponential on nested invalid calls.
	MaxNesting = 12
	// MaxOutputBytes caps the decoded output (the tester's 10 MiB).
	MaxOutputBytes = 10 << 20
	// MaxLogCharacters caps the collector's log (the platform stores
	// 262,144 characters of it).
	MaxLogCharacters = 262144
	// DefaultMaxOutputObjects caps the JSON objects in an output that OTTL
	// rules parse: 3.5 million tiny records measured 1.87 GB.
	DefaultMaxOutputObjects = 1_000_000

	// maxMessageBytes caps every message an answer carries.
	maxMessageBytes = 4096
	// maxMatches is how many matches (and misses, and samples) a failure's
	// detail shows.
	maxMatches = 5
	// maxMatchTextBytes caps a shown match's text.
	maxMatchTextBytes = 200
	// contextBytes is the context shown on each side of a match.
	contextBytes = 40
	// maxPathBytes caps a match's record path.
	maxPathBytes = 200
	// maxCountedMatches is how many matches are counted exactly.
	maxCountedMatches = 100_000
	// checkEveryCandidates is how often the text matcher calls its
	// checkpoint, in candidate positions.
	checkEveryCandidates = 4096
	// checkEveryBytes is how often a scan calls its checkpoint.
	checkEveryBytes = 64 << 10
)

// The messages Preflight rulings 6, 7 and 10 set.
const (
	// NotCheckedDeadline is each unfinished rule's error when the rules took
	// longer than the evaluation's deadline (the owner, spec decision 30).
	NotCheckedDeadline = "Not checked: the rules took longer than 20 s to check."
	// NotCheckedMemory is each unfinished rule's error when the kernel
	// killed the evaluation for its memory.
	NotCheckedMemory = "Not checked: checking the rules ran out of memory."
	// OutputTooLarge is each OTTL rule's error when the output holds more
	// JSON objects than OTTL rules may parse.
	OutputTooLarge = "The output is too large to check with OTTL rules."
	// EmptyText is a text rule's problem when its text is only whitespace.
	EmptyText = "The rule's text is empty."
	// TruncatedAdvisory is every output rule's advisory when the tester cut
	// the output (R-006).
	TruncatedAdvisory = "Only the first 10 MiB of the output was checked (R-006)."
	// ruleFailed is a rule's error when checking it panicked.
	ruleFailed = "The rule couldn't be checked: the evaluator failed on it."
)

// Rule is one rule as a request carries it, its shape already checked
// (internal/server). ID is empty in a validate request.
type Rule struct {
	ID      string  `json:"id,omitempty"`
	Kind    string  `json:"kind"`
	Target  string  `json:"target"`
	Pattern *string `json:"pattern,omitempty"`
	OTTL    *OTTL   `json:"ottl,omitempty"`
}

// OTTL is an OTTL rule's condition, expression and quantifier.
type OTTL struct {
	Context    string  `json:"context"`
	Quantifier string  `json:"quantifier"`
	Condition  *string `json:"condition,omitempty"`
	Expression *string `json:"expression,omitempty"`
	Count      *Count  `json:"count,omitempty"`
}

// Count compares a count (of records, or of distinct values).
type Count struct {
	Operator string `json:"operator"`
	Value    int64  `json:"value"`
	Value2   *int64 `json:"value2,omitempty"`
}

// Result is one rule's outcome, as the answer carries it. Error means
// Passed is false and Detail is null (decision 3: a rule's own error fails
// it). Detail is one of the four shapes below, already encoded, or null.
type Result struct {
	ID       string          `json:"id"`
	Passed   bool            `json:"passed"`
	Error    *string         `json:"error"`
	Advisory *string         `json:"advisory"`
	Detail   json.RawMessage `json:"detail"`
}

// The four failure details.

// NoMatch: a contains rule found nothing.
type NoMatch struct {
	Kind               string `json:"kind"`
	Source             string `json:"source"`
	SearchedCharacters int    `json:"searchedCharacters"`
}

// UnexpectedMatch: a not-contains rule found matches.
type UnexpectedMatch struct {
	Kind            string  `json:"kind"`
	Source          string  `json:"source"`
	TotalMatchCount int     `json:"totalMatchCount"`
	MoreMatches     bool    `json:"moreMatches"`
	Matches         []Match `json:"matches"`
}

// Match is one shown match: its text and the text around it on its line,
// and its record (an OutputRecord or a LogLine).
type Match struct {
	Text          string `json:"text"`
	TextTruncated bool   `json:"textTruncated"`
	Before        string `json:"before"`
	After         string `json:"after"`
	Record        any    `json:"record"`
}

// OutputRecord names where in the output a match is: the element of the
// output's records (null when the match starts outside every record), and
// the JSON path, inside that record, of the innermost value holding the
// whole match ("" for the record itself, or when the match runs past it).
type OutputRecord struct {
	Index *int   `json:"index"`
	Path  string `json:"path"`
}

// LogLine names the log's line a match starts on, from 1.
type LogLine struct {
	Line int `json:"line"`
}

// RecordMismatch: an all, any, none or count OTTL rule failed.
type RecordMismatch struct {
	Kind         string `json:"kind"`
	Context      string `json:"context"`
	TotalCount   int    `json:"totalCount"`
	MatchedCount int    `json:"matchedCount"`
	MissCount    int    `json:"missCount"`
	Misses       []Miss `json:"misses"`
}

// Miss is one record that failed an OTTL rule.
type Miss struct {
	Index   int    `json:"index"`
	Reason  string `json:"reason"`
	Snippet string `json:"snippet"`
}

// DistinctMismatch: a distinct OTTL rule's count of distinct values failed.
type DistinctMismatch struct {
	Kind          string   `json:"kind"`
	TotalCount    int      `json:"totalCount"`
	MatchedCount  int      `json:"matchedCount"`
	DistinctCount int      `json:"distinctCount"`
	Samples       []string `json:"samples"`
}

// NotChecked is the result of a rule the evaluation never finished.
func NotChecked(id, message string) Result {
	return Result{ID: id, Passed: false, Error: &message}
}

// Complete returns one result per rule, in the rules' order: the result the
// evaluation wrote for it, or NotChecked with message. got holds the
// finished rules' results in order, as the child writes them.
func Complete(rules []Rule, got []Result, message string) []Result {
	results := make([]Result, len(rules))
	for i, rule := range rules {
		if i < len(got) && got[i].ID == rule.ID {
			results[i] = got[i]
			continue
		}
		results[i] = NotChecked(rule.ID, message)
	}
	return results
}

func failed(id, message string) Result {
	message = capMessage(message)
	return Result{ID: id, Passed: false, Error: &message}
}

// TooComplex is validate's problem when its check was killed at its limit,
// naming the field it was checking: "The pattern is too complex to check.",
// or the condition, or the expression (the controller's Ruling 33).
func TooComplex(field string) string {
	name := "condition"
	switch field {
	case FieldPattern:
		name = "pattern"
	case FieldExpression:
		name = "expression"
	}
	return "The " + name + " is too complex to check."
}

// encodeDetail encodes a detail without escaping <, > and & (which would
// take six bytes each).
func encodeDetail(detail any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(detail); err != nil {
		// The details are plain structs of strings and numbers.
		panic(err)
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}
