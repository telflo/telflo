// New in D15a Task 2: the rules package's test helpers.

package rules

import (
	"encoding/json"
	"fmt"
	"testing"
)

var ruleCounter int

func nextID() string {
	ruleCounter++
	return fmt.Sprintf("rule-%d", ruleCounter)
}

func strPtr(s string) *string { return &s }

func int64Ptr(v int64) *int64 { return &v }

// textRule is a text or regex rule on the output.
func textRule(kind, pattern string) Rule {
	return Rule{ID: nextID(), Kind: kind, Target: TargetOutput, Pattern: strPtr(pattern)}
}

// stderrRule is a text or regex rule on the collector's log.
func stderrRule(kind, pattern string) Rule {
	return Rule{ID: nextID(), Kind: kind, Target: TargetStderr, Pattern: strPtr(pattern)}
}

func ottlRule(context, quantifier, condition string) Rule {
	o := &OTTL{Context: context, Quantifier: quantifier}
	if condition != "" {
		o.Condition = strPtr(condition)
	}
	return Rule{ID: nextID(), Kind: KindOTTL, Target: TargetOutput, OTTL: o}
}

// run evaluates rules against an output (nil: absent) and a log, with no
// deadline, and returns one result per rule.
func run(t *testing.T, signal string, output *string, log string, rules ...Rule) []Result {
	t.Helper()
	return runInput(t, Input{Signal: signal, OutputPresent: output != nil, Log: log, Rules: rules, MaxOutputObjects: DefaultMaxOutputObjects}, output)
}

func runInput(t *testing.T, in Input, output *string) []Result {
	t.Helper()
	var bytes []byte
	if output != nil {
		bytes = []byte(*output)
	}
	var results []Result
	err := Evaluate(in, bytes, nil, func(r Result) error {
		results = append(results, r)
		return nil
	})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(results) != len(in.Rules) {
		t.Fatalf("got %d results for %d rules", len(results), len(in.Rules))
	}
	for i, r := range results {
		if r.ID != in.Rules[i].ID {
			t.Fatalf("result %d is %q's, want %q's", i, r.ID, in.Rules[i].ID)
		}
		if r.Error != nil && (r.Passed || r.Detail != nil && string(r.Detail) != "null") {
			t.Fatalf("result %d has an error but passed or carries a detail: %+v", i, r)
		}
	}
	return results
}

// one evaluates a single rule over an output with an empty log.
func one(t *testing.T, output string, rule Rule) Result {
	t.Helper()
	return run(t, "logs", &output, "", rule)[0]
}

// oneLog evaluates a single rule with an output and a log.
func oneLog(t *testing.T, output, log string, rule Rule) Result {
	t.Helper()
	return run(t, "logs", &output, log, rule)[0]
}

// detail decodes a result's detail, failing when it has none.
type matchDetail struct {
	Text          string         `json:"text"`
	TextTruncated bool           `json:"textTruncated"`
	Before        string         `json:"before"`
	After         string         `json:"after"`
	Record        map[string]any `json:"record"`
}

type anyDetail struct {
	Kind               string        `json:"kind"`
	Source             string        `json:"source"`
	SearchedCharacters int           `json:"searchedCharacters"`
	TotalMatchCount    int           `json:"totalMatchCount"`
	MoreMatches        bool          `json:"moreMatches"`
	Matches            []matchDetail `json:"matches"`
	Context            string        `json:"context"`
	TotalCount         int           `json:"totalCount"`
	MatchedCount       int           `json:"matchedCount"`
	MissCount          int           `json:"missCount"`
	Misses             []Miss        `json:"misses"`
	DistinctCount      int           `json:"distinctCount"`
	Samples            []string      `json:"samples"`
}

func detailOf(t *testing.T, r Result) anyDetail {
	t.Helper()
	if len(r.Detail) == 0 || string(r.Detail) == "null" {
		t.Fatalf("result %s has no detail: %+v", r.ID, r)
	}
	var d anyDetail
	if err := json.Unmarshal(r.Detail, &d); err != nil {
		t.Fatalf("detail: %v", err)
	}
	return d
}

// detailKeys lists a detail's members, to hold each kind's exact shape.
func detailKeys(t *testing.T, r Result) map[string]bool {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(r.Detail, &m); err != nil {
		t.Fatalf("detail: %v", err)
	}
	keys := map[string]bool{}
	for k := range m {
		keys[k] = true
	}
	return keys
}

func noDetail(r Result) bool {
	return len(r.Detail) == 0 || string(r.Detail) == "null"
}

func errorOf(r Result) string {
	if r.Error == nil {
		return ""
	}
	return *r.Error
}

func advisoryOf(r Result) string {
	if r.Advisory == nil {
		return ""
	}
	return *r.Advisory
}
