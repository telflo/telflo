// The requests' shapes, checked as openapi.yaml states them, member by
// member, so the server refuses what the file refuses: an unknown member, a
// null where none is allowed, a wrong type, an unknown kind or enum value,
// a length past its cap. A refusal's message names the member's path and
// the rule broken, never a value from the request. A rule's content (its
// text's byte length, its OTTL, its regex) is checked later, as that rule's
// own error (internal/rules), never the request's.

package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

// The request's own caps (openapi.yaml).
const (
	// maxIDCharacters bounds a rule's id (the platform sends a UUID).
	maxIDCharacters = 128
	// maxBase64Characters is the base64 of rules.MaxOutputBytes.
	maxBase64Characters = (rules.MaxOutputBytes + 2) / 3 * 4
	// maxCountValue is the largest count (the database's integer).
	maxCountValue = math.MaxInt32
)

var (
	contexts    = []string{"log", "span", "spanevent", "metric", "datapoint", "resource", "scope"}
	quantifiers = []string{"all", "any", "none", "count", "distinct"}
	operators   = []string{"eq", "ne", "gt", "gte", "lt", "lte", "between"}
	targets     = []string{rules.TargetOutput, rules.TargetStderr}
)

// shapeError is a request that doesn't follow the contract: 400
// invalid_request.
type shapeError struct {
	message string
}

func (e *shapeError) Error() string { return e.message }

func shapef(format string, args ...any) *shapeError {
	return &shapeError{message: "The request doesn't follow the contract: " + fmt.Sprintf(format, args...)}
}

// evaluateRequest is a checked evaluate request.
type evaluateRequest struct {
	signal        string
	outputPresent bool
	output        []byte
	truncated     bool
	log           string
	rules         []rules.Rule
}

// validateRequest is a checked validate request.
type validateRequest struct {
	signal string
	rule   rules.Rule
}

func decodeEvaluate(body []byte) (evaluateRequest, *shapeError) {
	members, err := object(body, "the body", []string{"signal", "output", "log", "rules"}, nil)
	if err != nil {
		return evaluateRequest{}, err
	}
	var req evaluateRequest
	if req.signal, err = enum(members["signal"], "signal", rules.Signals); err != nil {
		return evaluateRequest{}, err
	}
	if !isNull(members["output"]) {
		output, err := object(members["output"], "output", []string{"base64", "truncated"}, nil)
		if err != nil {
			return evaluateRequest{}, shapef("output must be null or an object of base64 and truncated")
		}
		encoded, err := str(output["base64"], "output.base64", 0, maxBase64Characters)
		if err != nil {
			return evaluateRequest{}, err
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return evaluateRequest{}, shapef("output.base64 isn't standard base64")
		}
		if len(decoded) > rules.MaxOutputBytes {
			return evaluateRequest{}, shapef("output.base64 decodes to more than %d bytes", rules.MaxOutputBytes)
		}
		if req.truncated, err = boolean(output["truncated"], "output.truncated"); err != nil {
			return evaluateRequest{}, err
		}
		req.outputPresent, req.output = true, decoded
	}
	if req.log, err = str(members["log"], "log", 0, rules.MaxLogCharacters); err != nil {
		return evaluateRequest{}, err
	}
	items, err := array(members["rules"], "rules", 1, rules.MaxRules)
	if err != nil {
		return evaluateRequest{}, err
	}
	seen := map[string]bool{}
	for i, item := range items {
		path := fmt.Sprintf("rules[%d]", i)
		rule, err := decodeRule(item, path, true)
		if err != nil {
			return evaluateRequest{}, err
		}
		if seen[rule.ID] {
			return evaluateRequest{}, shapef("%s.id repeats an earlier rule's id", path)
		}
		seen[rule.ID] = true
		req.rules = append(req.rules, rule)
	}
	return req, nil
}

// decodeLint checks a lint request: one of the contexts, and up to three
// arrays of strings of at most 8,192 characters, 1 to 200 strings in all.
// A text's content (its bytes, its nesting, its parse) is the
// item's own verdict, never the request's.
func decodeLint(body []byte) (rules.LintInput, *shapeError) {
	members, err := object(body, "the body", []string{"context"}, []string{"conditions", "statements", "valueExpressions"})
	if err != nil {
		return rules.LintInput{}, err
	}
	var input rules.LintInput
	if input.Context, err = enum(members["context"], "context", contexts); err != nil {
		return rules.LintInput{}, err
	}
	total := 0
	for _, field := range []struct {
		name string
		dst  *[]string
	}{{"conditions", &input.Conditions}, {"statements", &input.Statements}, {"valueExpressions", &input.ValueExpressions}} {
		raw, ok := members[field.name]
		if !ok {
			continue
		}
		items, err := array(raw, field.name, 0, rules.MaxLintItems)
		if err != nil {
			return rules.LintInput{}, err
		}
		texts := make([]string, len(items))
		for i, item := range items {
			if texts[i], err = str(item, fmt.Sprintf("%s[%d]", field.name, i), 0, rules.MaxTextBytes); err != nil {
				return rules.LintInput{}, err
			}
		}
		*field.dst = texts
		total += len(texts)
	}
	if total < 1 || total > rules.MaxLintItems {
		return rules.LintInput{}, shapef("conditions, statements and valueExpressions must hold from 1 to %d texts in all", rules.MaxLintItems)
	}
	return input, nil
}

func decodeValidate(body []byte) (validateRequest, *shapeError) {
	members, err := object(body, "the body", []string{"signal", "rule"}, nil)
	if err != nil {
		return validateRequest{}, err
	}
	var req validateRequest
	if req.signal, err = enum(members["signal"], "signal", rules.Signals); err != nil {
		return validateRequest{}, err
	}
	if req.rule, err = decodeRule(members["rule"], "rule", false); err != nil {
		return validateRequest{}, err
	}
	return req, nil
}

// decodeRule checks one rule: a text or regex rule {id, kind, target,
// pattern}, or an OTTL rule {id, kind: ottl, target: output, ottl}. A
// validate request's rule has no id.
func decodeRule(raw json.RawMessage, path string, withID bool) (rules.Rule, *shapeError) {
	// The kind decides the members, so read it first.
	loose, err := object(raw, path, []string{"kind"}, []string{"id", "target", "pattern", "ottl"})
	if err != nil {
		return rules.Rule{}, err
	}
	kind, err := enum(loose["kind"], path+".kind", rules.Kinds)
	if err != nil {
		return rules.Rule{}, err
	}
	required := []string{"kind", "target"}
	if withID {
		required = append(required, "id")
	}
	if kind == rules.KindOTTL {
		required = append(required, "ottl")
	} else {
		required = append(required, "pattern")
	}
	members, err := object(raw, path, required, nil)
	if err != nil {
		return rules.Rule{}, err
	}
	rule := rules.Rule{Kind: kind}
	if withID {
		if rule.ID, err = str(members["id"], path+".id", 1, maxIDCharacters); err != nil {
			return rules.Rule{}, err
		}
	}
	if rule.Target, err = enum(members["target"], path+".target", targets); err != nil {
		return rules.Rule{}, err
	}
	if kind != rules.KindOTTL {
		pattern, err := str(members["pattern"], path+".pattern", 1, rules.MaxTextBytes)
		if err != nil {
			return rules.Rule{}, err
		}
		rule.Pattern = &pattern
		return rule, nil
	}
	if rule.Target != rules.TargetOutput {
		return rules.Rule{}, shapef("%s.target must be output: an OTTL rule reads the output only", path)
	}
	if rule.OTTL, err = decodeOTTL(members["ottl"], path+".ottl"); err != nil {
		return rules.Rule{}, err
	}
	return rule, nil
}

func decodeOTTL(raw json.RawMessage, path string) (*rules.OTTL, *shapeError) {
	members, err := object(raw, path, []string{"context", "quantifier"}, []string{"condition", "expression", "count"})
	if err != nil {
		return nil, err
	}
	o := &rules.OTTL{}
	if o.Context, err = enum(members["context"], path+".context", contexts); err != nil {
		return nil, err
	}
	if o.Quantifier, err = enum(members["quantifier"], path+".quantifier", quantifiers); err != nil {
		return nil, err
	}
	for _, field := range []struct {
		name string
		dst  **string
	}{{"condition", &o.Condition}, {"expression", &o.Expression}} {
		if raw, ok := members[field.name]; ok {
			text, err := str(raw, path+"."+field.name, 0, rules.MaxTextBytes)
			if err != nil {
				return nil, err
			}
			*field.dst = &text
		}
	}
	if raw, ok := members["count"]; ok {
		count, err := object(raw, path+".count", []string{"operator", "value"}, []string{"value2"})
		if err != nil {
			return nil, err
		}
		o.Count = &rules.Count{}
		if o.Count.Operator, err = enum(count["operator"], path+".count.operator", operators); err != nil {
			return nil, err
		}
		if o.Count.Value, err = integer(count["value"], path+".count.value", 0, maxCountValue); err != nil {
			return nil, err
		}
		if raw, ok := count["value2"]; ok {
			value2, err := integer(raw, path+".count.value2", 0, maxCountValue)
			if err != nil {
				return nil, err
			}
			o.Count.Value2 = &value2
		}
	}
	return o, nil
}

// object reads raw as a JSON object with every required member and no
// member outside required and optional.
func object(raw json.RawMessage, path string, required, optional []string) (map[string]json.RawMessage, *shapeError) {
	if first(raw) != '{' {
		return nil, shapef("%s must be an object", path)
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil {
		return nil, shapef("%s must be an object", path)
	}
	for name := range members {
		if !slices.Contains(required, name) && !slices.Contains(optional, name) {
			return nil, shapef("%s has a member the contract doesn't name", path)
		}
	}
	for _, name := range required {
		if _, ok := members[name]; !ok {
			return nil, shapef("%s.%s is missing", path, name)
		}
	}
	return members, nil
}

func array(raw json.RawMessage, path string, minItems, maxItems int) ([]json.RawMessage, *shapeError) {
	var items []json.RawMessage
	if first(raw) != '[' || json.Unmarshal(raw, &items) != nil {
		return nil, shapef("%s must be an array", path)
	}
	if len(items) < minItems || len(items) > maxItems {
		return nil, shapef("%s must hold from %d to %d items", path, minItems, maxItems)
	}
	return items, nil
}

// str reads a string of minChars to maxChars characters (code points, as
// JSON Schema counts them).
func str(raw json.RawMessage, path string, minChars, maxChars int) (string, *shapeError) {
	var s string
	if first(raw) != '"' || json.Unmarshal(raw, &s) != nil {
		return "", shapef("%s must be a string", path)
	}
	if n := utf8.RuneCountInString(s); n < minChars || n > maxChars {
		return "", shapef("%s must be from %d to %d characters", path, minChars, maxChars)
	}
	return s, nil
}

func enum(raw json.RawMessage, path string, values []string) (string, *shapeError) {
	var s string
	if first(raw) != '"' || json.Unmarshal(raw, &s) != nil || !slices.Contains(values, s) {
		return "", shapef("%s must be one of %s", path, strings.Join(values, ", "))
	}
	return s, nil
}

func boolean(raw json.RawMessage, path string) (bool, *shapeError) {
	var b bool
	if c := first(raw); (c != 't' && c != 'f') || json.Unmarshal(raw, &b) != nil {
		return false, shapef("%s must be true or false", path)
	}
	return b, nil
}

// integer reads a JSON number with no fractional part (JSON Schema's
// integer: 3.0 is one) from min to max.
func integer(raw json.RawMessage, path string, min, max int64) (int64, *shapeError) {
	c := first(raw)
	refuse := shapef("%s must be a whole number from %d to %d", path, min, max)
	if c != '-' && (c < '0' || c > '9') || !json.Valid(raw) {
		return 0, refuse
	}
	f, err := strconv.ParseFloat(string(bytes.TrimSpace(raw)), 64)
	if err != nil || f != math.Trunc(f) || f < float64(min) || f > float64(max) {
		return 0, refuse
	}
	return int64(f), nil
}

func isNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

func first(raw json.RawMessage) byte {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0
	}
	return trimmed[0]
}
