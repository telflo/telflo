// The lint child's work. The public API's OTTL lint sends up to 200
// conditions, statements and value expressions against one context; OTTL's
// parser can't be interrupted, so they are parsed in a child process the
// server kills at its limit (internal/server's lint), as a rule's check is.
// Each text gets the rule checks' guards first (textProblem: its length,
// its nesting, a single-escaped regex sequence), then the parse with the
// standard function set (ottlassert.Linter); the child writes one line per
// item as it finishes, so the items done before a kill keep their verdicts.
// A verdict never carries the text: the API echoes the caller's own.

package rules

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"

	"github.com/telflo/ottl-evaluator/pkg/ottlassert"
)

// The kinds of text lint takes, as its answer names them.
const (
	LintKindCondition       = "condition"
	LintKindStatement       = "statement"
	LintKindValueExpression = "valueExpression"
)

const (
	// MaxLintItems is how many texts one lint request may carry, in all.
	MaxLintItems = 200
	// NotCheckedLint is each item's error when the lint was killed at its
	// limit before reaching it.
	NotCheckedLint = "Not checked: the expressions took too long to check."
	// NotCheckedLintMemory is each unreached item's error when the kernel or
	// the Go runtime killed the lint child for memory.
	NotCheckedLintMemory = "Not checked: checking the expressions ran out of memory."
)

// LintInput is a lint child's one line: the context and the texts, as the
// request carried them.
type LintInput struct {
	Context          string   `json:"context"`
	Conditions       []string `json:"conditions,omitempty"`
	Statements       []string `json:"statements,omitempty"`
	ValueExpressions []string `json:"valueExpressions,omitempty"`
}

// LintTarget is one text to lint: its kind, its index among that kind's
// texts, and the text.
type LintTarget struct {
	Kind  string
	Index int
	Text  string
}

// Targets lists the input's texts in the answer's order: the conditions,
// then the statements, then the value expressions, each in the request's
// order.
func (in LintInput) Targets() []LintTarget {
	var targets []LintTarget
	for _, group := range []struct {
		kind  string
		texts []string
	}{
		{LintKindCondition, in.Conditions},
		{LintKindStatement, in.Statements},
		{LintKindValueExpression, in.ValueExpressions},
	} {
		for i, text := range group.texts {
			targets = append(targets, LintTarget{Kind: group.kind, Index: i, Text: text})
		}
	}
	return targets
}

// LintVerdict is one item's verdict: the line a lint child writes, and the
// item the server answers. Error is there only when the item isn't valid.
type LintVerdict struct {
	Kind  string  `json:"kind"`
	Index int     `json:"index"`
	Valid bool    `json:"valid"`
	Error *string `json:"error,omitempty"`
}

// NotCheckedVerdict is the verdict of an item the lint never reached.
func NotCheckedVerdict(target LintTarget, message string) LintVerdict {
	return LintVerdict{Kind: target.Kind, Index: target.Index, Valid: false, Error: &message}
}

// lintNames are the words a kind's problem uses.
var lintNames = map[string]string{
	LintKindCondition:       "condition",
	LintKindStatement:       "statement",
	LintKindValueExpression: "value expression",
}

// LintText checks one text: the guards first (its length, its nesting, a
// single-escaped regex sequence), then whether it is blank, then the parse.
// A problem is worded as a rule's: a parser's message after
// SyntaxErrorPrefix, every other in its own words.
func LintText(linter *ottlassert.Linter, target LintTarget) LintVerdict {
	verdict := LintVerdict{Kind: target.Kind, Index: target.Index, Valid: true}
	name := lintNames[target.Kind]
	fail := func(message string) LintVerdict {
		message = capMessage(message)
		verdict.Valid, verdict.Error = false, &message
		return verdict
	}
	if p, ok := textProblem("", name, target.Text); ok {
		return fail(p.Message)
	}
	if isBlank(target.Text) {
		return fail(fmt.Sprintf("The %s is empty.", name))
	}
	var err error
	switch target.Kind {
	case LintKindCondition:
		err = linter.ParseCondition(target.Text)
	case LintKindStatement:
		err = linter.ParseStatement(target.Text)
	case LintKindValueExpression:
		err = linter.ParseValueExpression(target.Text)
	default:
		return fail(fmt.Sprintf("Unknown kind %q.", target.Kind))
	}
	if err != nil {
		return fail(SyntaxErrorPrefix + err.Error())
	}
	return verdict
}

// RunLintChild is the lint-child subcommand: it reads one LintInput and
// writes one LintVerdict line per text, in Targets' order, each flushed as
// it is written.
func RunLintChild(stdin io.Reader, stdout io.Writer) int {
	if preferOOMKill() != nil {
		return ExitSetup
	}
	var input LintInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return ExitInput
	}
	linter, err := ottlassert.NewLinter(ottlassert.Context(input.Context))
	if err != nil {
		return ExitInput
	}
	targets := input.Targets()
	if len(targets) == 0 || len(targets) > MaxLintItems {
		return ExitInput
	}
	out := bufio.NewWriter(stdout)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	for _, target := range targets {
		if err := enc.Encode(LintText(linter, target)); err != nil {
			return ExitInput
		}
		if err := out.Flush(); err != nil {
			return ExitInput
		}
	}
	return ExitDone
}
