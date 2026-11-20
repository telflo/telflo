// Checking a run's rules, one at a time, against its output and the
// collector's log. Text and regex rules have whitespace tolerance and
// Go's regexp, and a match names its record.

package rules

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/telflo/ottl-evaluator/pkg/ottlassert"
)

// Input is what one evaluation checks: the request, its shape checked, but
// for the output's bytes, which travel beside it.
type Input struct {
	Signal string `json:"signal"`
	// OutputPresent is false when the collector wrote no record (the
	// request's output was null).
	OutputPresent bool `json:"outputPresent"`
	// Truncated: the tester cut the output at 10 MiB (R-006).
	Truncated bool   `json:"truncated"`
	Log       string `json:"log"`
	Rules     []Rule `json:"rules"`
	// MaxOutputObjects caps the JSON objects OTTL rules may parse.
	MaxOutputObjects int `json:"maxOutputObjects"`
}

// Evaluate checks each rule in order, calling emit with its result. check
// is called before each rule and inside every loop; its error stops the
// evaluation, leaving the rules from the one it stopped in without a
// result, and Evaluate returns it.
func Evaluate(in Input, output []byte, check ottlassert.Checkpoint, emit func(Result) error) error {
	if check == nil {
		check = func() error { return nil }
	}
	if !in.OutputPresent {
		output = nil
	}
	e := &evaluation{in: in, output: output, log: []byte(in.Log), check: check}
	for _, rule := range in.Rules {
		if err := check(); err != nil {
			return err
		}
		result, err := e.rule(rule)
		if err != nil {
			return err
		}
		if err := emit(result); err != nil {
			return err
		}
	}
	return nil
}

type evaluation struct {
	in     Input
	output []byte
	log    []byte
	check  ottlassert.Checkpoint

	// The output's facts, found once.
	factsDone bool
	facts     facts
	// The output's OTLP documents, parsed once, or why they can't be.
	docsDone    bool
	docs        *ottlassert.Documents
	docsProblem string
}

// rule checks one rule. Its only error is the checkpoint's; a panic is the
// rule's own error.
func (e *evaluation) rule(rule Rule) (result Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result, err = failed(rule.ID, ruleFailed), nil
		}
	}()
	if problems := Check(e.in.Signal, rule, true, nil); len(problems) > 0 {
		return failed(rule.ID, problems[0].Message), nil
	}
	switch rule.Kind {
	case KindContainsText, KindNotContainsText:
		result, err = e.text(rule)
	case KindContainsRegex, KindNotContainsRegex:
		result, err = e.regex(rule)
	case KindOTTL:
		result, err = e.ottl(rule)
	}
	if err != nil {
		return Result{}, err
	}
	if result.Error == nil && rule.Target == TargetOutput && e.in.OutputPresent && e.in.Truncated {
		addAdvisory(&result, TruncatedAdvisory)
	}
	return result, nil
}

func addAdvisory(result *Result, advisory string) {
	if result.Advisory != nil {
		advisory = *result.Advisory + " " + advisory
	}
	advisory = capMessage(advisory)
	result.Advisory = &advisory
}

// haystack is what a text or regex rule searches: the output's bytes as
// they are, or the log.
func (e *evaluation) haystack(target string) []byte {
	if target == TargetStderr {
		return e.log
	}
	return e.output
}

func (e *evaluation) text(rule Rule) (Result, error) {
	h := e.haystack(rule.Target)
	pattern := newTextPattern(*rule.Pattern)
	w := newWork(e.check)
	if rule.Kind == KindContainsText {
		_, _, found, err := pattern.find(h, 0, w)
		if err != nil {
			return Result{}, err
		}
		if found {
			return Result{ID: rule.ID, Passed: true}, nil
		}
		return e.noMatch(rule, h, w)
	}
	spans, err := pattern.findAll(h, maxCountedMatches+1, w)
	if err != nil {
		return Result{}, err
	}
	if len(spans) == 0 {
		return Result{ID: rule.ID, Passed: true}, nil
	}
	return e.unexpectedMatch(rule, h, spans, len(spans) > maxCountedMatches, w)
}

func (e *evaluation) regex(rule Rule) (Result, error) {
	h := e.haystack(rule.Target)
	// Check compiled it already.
	re := regexp.MustCompile(*rule.Pattern)
	w := newWork(e.check)
	if rule.Kind == KindContainsRegex {
		if re.Match(h) {
			return Result{ID: rule.ID, Passed: true}, nil
		}
		return e.noMatch(rule, h, w)
	}
	all := re.FindAllIndex(h, maxCountedMatches+1)
	if len(all) == 0 {
		return Result{ID: rule.ID, Passed: true}, nil
	}
	more := len(all) > maxCountedMatches
	counted := all[:min(len(all), maxCountedMatches)]
	// Zero-width matches fail the rule but have nothing to show.
	var spans [][2]int
	for _, m := range counted {
		if m[1] > m[0] {
			spans = append(spans, [2]int{m[0], m[1]})
		}
	}
	if len(spans) == 0 {
		// No detail to show, so the advisory says why it failed.
		result := Result{ID: rule.ID, Passed: false}
		addAdvisory(&result, emptyMatchesAdvisory(len(counted), more))
		return result, nil
	}
	return e.unexpectedMatch(rule, h, spans, more, w)
}

// emptyMatchesAdvisory is a not-contains regex's advisory when every match
// it found was empty (`x*`, `^`, `\b`): the rule failed, and its detail has
// no match to show. It never quotes the text searched. Past
// maxCountedMatches it speaks of the counted matches only, as the
// rule does.
func emptyMatchesAdvisory(count int, more bool) string {
	switch {
	case more:
		return fmt.Sprintf("The pattern's first %s matches were all empty text, so there is no match to show.", groupThousands(count))
	case count == 1:
		return "The pattern matched only empty text (once), so there is no match to show."
	}
	return fmt.Sprintf("The pattern matched only empty text (%s times), so there is no match to show.", groupThousands(count))
}

// groupThousands writes n with a comma between each group of three digits.
func groupThousands(n int) string {
	digits := fmt.Sprint(n)
	var b []byte
	for i := range len(digits) {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b = append(b, ',')
		}
		b = append(b, digits[i])
	}
	return string(b)
}

func (e *evaluation) noMatch(rule Rule, h []byte, w *work) (Result, error) {
	searched, err := countRunes(h, w)
	if err != nil {
		return Result{}, err
	}
	return Result{ID: rule.ID, Passed: false, Detail: encodeDetail(NoMatch{
		Kind: "no_match", Source: rule.Target, SearchedCharacters: searched,
	})}, nil
}

// unexpectedMatch builds the detail of a not-contains rule's matches: all
// counted (up to maxCountedMatches), the first maxMatches shown, their
// snippets and records built only for those.
func (e *evaluation) unexpectedMatch(rule Rule, h []byte, spans [][2]int, more bool, w *work) (Result, error) {
	total := min(len(spans), maxCountedMatches)
	shown := spans[:min(len(spans), maxMatches)]
	matches := make([]Match, len(shown))
	for i, span := range shown {
		matches[i] = matchAt(h, span[0], span[1])
	}
	if rule.Target == TargetStderr {
		lines, err := lineNumbers(h, shown, w)
		if err != nil {
			return Result{}, err
		}
		for i := range matches {
			matches[i].Record = LogLine{Line: lines[i]}
		}
	} else {
		records, err := e.outputRecords(shown, w)
		if err != nil {
			return Result{}, err
		}
		for i := range matches {
			matches[i].Record = records[i]
		}
	}
	return Result{ID: rule.ID, Passed: false, Detail: encodeDetail(UnexpectedMatch{
		Kind: "unexpected_match", Source: rule.Target, TotalMatchCount: total,
		MoreMatches: more, Matches: matches,
	})}, nil
}

func (e *evaluation) outputFacts() (facts, error) {
	if !e.factsDone {
		f, err := scanFacts(e.output, newWork(e.check))
		if err != nil {
			return facts{}, err
		}
		e.facts, e.factsDone = f, true
	}
	return e.facts, nil
}

func (e *evaluation) outputRecords(spans [][2]int, w *work) ([]OutputRecord, error) {
	f, err := e.outputFacts()
	if err != nil {
		return nil, err
	}
	if !f.wellFormed {
		return make([]OutputRecord, len(spans)), nil
	}
	return locateOutput(e.output, spans, f.wrapped, w)
}

// documents parses the output's OTLP documents once: none when the output
// is absent or empty; the records of the tester's {"records":[…]} wrapper
// (pdata would read the wrapper as an empty document, and every all rule
// would pass); else one document, a JSON array of them, or NDJSON. The
// problem, when there is one, is every OTTL rule's error.
func (e *evaluation) documents() (*ottlassert.Documents, string, error) {
	if e.docsDone {
		return e.docs, e.docsProblem, nil
	}
	signal := ottlassert.Signal(e.in.Signal)
	var raws [][]byte
	if len(bytes.TrimSpace(e.output)) > 0 {
		f, err := e.outputFacts()
		if err != nil {
			return nil, "", err
		}
		if f.objects > e.in.MaxOutputObjects {
			e.docsDone, e.docsProblem = true, OutputTooLarge
			return nil, e.docsProblem, nil
		}
		if f.wrapped {
			for _, span := range f.records {
				raws = append(raws, e.output[span[0]:span[1]])
			}
		} else {
			raws, err = ottlassert.SplitPayload(string(e.output))
			if err != nil {
				e.docsDone, e.docsProblem = true, notOTLP(e.in.Signal, -1, 0)
				return nil, e.docsProblem, nil
			}
		}
		for i, raw := range raws {
			if !onlySignalKeys(raw, e.in.Signal) {
				e.docsDone, e.docsProblem = true, notOTLP(e.in.Signal, i, len(raws))
				return nil, e.docsProblem, nil
			}
		}
	}
	docs, err := ottlassert.ParseDocuments(signal, raws, e.check)
	var documentErr *ottlassert.DocumentError
	switch {
	case errors.As(err, &documentErr):
		e.docsDone, e.docsProblem = true, notOTLP(e.in.Signal, documentErr.Index, len(raws))
		return nil, e.docsProblem, nil
	case err != nil:
		return nil, "", err
	}
	e.docsDone, e.docs = true, docs
	return docs, "", nil
}

func notOTLP(signal string, index, count int) string {
	if count > 1 && index >= 0 {
		return fmt.Sprintf("Record %d of the output isn't OTLP/JSON %s, so OTTL rules can't check it.", index+1, signal)
	}
	return fmt.Sprintf("The output isn't OTLP/JSON %s, so OTTL rules can't check it.", signal)
}

// rootKeys names each signal's OTLP/JSON root member, in its two
// spellings.
var rootKeys = map[string][2]string{
	"logs":    {"resourceLogs", "resource_logs"},
	"traces":  {"resourceSpans", "resource_spans"},
	"metrics": {"resourceMetrics", "resource_metrics"},
}

// onlySignalKeys says whether doc is a JSON object whose members are only
// the signal's root (pdata reads any other object as an empty document).
func onlySignalKeys(doc []byte, signal string) bool {
	dec := json.NewDecoder(bytes.NewReader(doc))
	if token, err := dec.Token(); err != nil || token != json.Delim('{') {
		return false
	}
	allowed := rootKeys[signal]
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return false
		}
		key, _ := token.(string)
		if key != allowed[0] && key != allowed[1] {
			return false
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return false
		}
	}
	return true
}

func (e *evaluation) ottl(rule Rule) (Result, error) {
	docs, problem, err := e.documents()
	if err != nil {
		return Result{}, err
	}
	if problem != "" {
		return failed(rule.ID, problem), nil
	}
	o := rule.OTTL
	assertion := ottlassert.Rule{
		ID:         rule.ID,
		Context:    ottlassert.Context(o.Context),
		Condition:  deref(o.Condition),
		Quantifier: ottlassert.Quantifier(o.Quantifier),
		Expression: deref(o.Expression),
	}
	if o.Count != nil {
		assertion.Count = &ottlassert.CountSpec{Operator: o.Count.Operator, Value: o.Count.Value, Value2: o.Count.Value2}
	}
	r, err := ottlassert.EvaluateRule(context.Background(), ottlassert.Signal(e.in.Signal), docs, assertion, e.check)
	if err != nil {
		return Result{}, err
	}
	if r.Error != "" {
		return failed(rule.ID, r.Error), nil
	}
	result := Result{ID: rule.ID, Passed: r.Passed}
	switch {
	case r.Passed:
		if r.TotalCount == 0 && (o.Quantifier == "all" || o.Quantifier == "none") {
			addAdvisory(&result, fmt.Sprintf(
				"No %s records in the output: %s holds only because there was nothing to check.", o.Context, o.Quantifier))
		}
	case o.Quantifier == "distinct":
		samples := r.DistinctSamples
		if samples == nil {
			samples = []string{}
		}
		result.Detail = encodeDetail(DistinctMismatch{
			Kind: "distinct_mismatch", TotalCount: r.TotalCount, MatchedCount: r.MatchedCount,
			DistinctCount: r.DistinctCount, Samples: samples,
		})
	default:
		misses := make([]Miss, len(r.Misses))
		for i, m := range r.Misses {
			misses[i] = Miss{Index: m.Index, Reason: m.Reason, Snippet: m.Snippet}
		}
		result.Detail = encodeDetail(RecordMismatch{
			Kind: "record_mismatch", Context: o.Context, TotalCount: r.TotalCount,
			MatchedCount: r.MatchedCount, MissCount: r.TotalMissCount, Misses: misses,
		})
	}
	return result, nil
}

// ErrDeadline is the child's checkpoint error once its deadline has passed.
var ErrDeadline = errors.New("the evaluation's deadline passed")
