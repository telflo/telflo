// Every condition Compare's "Create an OTTL rule" writes is one the
// evaluator accepts, in each record context, and tests exactly its own key
// and value, comparing numbers as the web's detection does (an int and a
// double as float64(int) == double; two ints exactly). The fixture,
// testdata/compare-prefills.json, holds the writer's cases: it is generated
// by `npm run fixture:compare-prefills --workspace @telflo/web`, and the
// web's apps/web/app/lib/test-runs/diff-rule-detection.test.ts checks it is
// what the writer writes today.

package rules

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type comparePrefill struct {
	Name       string          `json:"name"`
	Key        string          `json:"key"`
	Value      json.RawMessage `json:"value"`
	Kind       string          `json:"kind"`
	Quantifier string          `json:"quantifier"`
	Condition  string          `json:"condition"`
	// The values the web's detection takes for the same as Value (so it
	// offers no "changed"), and for others.
	SameAs        []json.RawMessage `json:"sameAs"`
	DifferentFrom []json.RawMessage `json:"differentFrom"`
}

func comparePrefills(t *testing.T) []comparePrefill {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "compare-prefills.json"))
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	var fixture struct {
		Description string           `json:"description"`
		Cases       []comparePrefill `json:"cases"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decoding the fixture: %v", err)
	}
	// 7 keys × 6 shapes, and the number and string cases.
	if len(fixture.Cases) < 42 {
		t.Fatalf("the fixture holds %d cases, want at least 42", len(fixture.Cases))
	}
	return fixture.Cases
}

// The record context of each signal, as the prefill's context follows the
// run's signal.
var prefillContexts = []struct{ signal, context string }{
	{"logs", "log"},
	{"traces", "span"},
	{"metrics", "datapoint"},
}

// oneRecord is a one-record output of signal whose record holds attributes
// (an OTLP/JSON attributes array).
func oneRecord(t *testing.T, signal string, attributes []map[string]json.RawMessage) string {
	t.Helper()
	encoded, err := json.Marshal(attributes)
	if err != nil {
		t.Fatalf("encoding the attributes: %v", err)
	}
	a := string(encoded)
	switch signal {
	case "logs":
		return `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":` + a + `}]}]}]}`
	case "traces":
		return `{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"s","attributes":` + a + `}]}]}]}`
	default:
		return `{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"asInt":"1","attributes":` + a + `}]}}]}]}]}`
	}
}

func attribute(t *testing.T, key string, value json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	encodedKey, err := json.Marshal(key)
	if err != nil {
		t.Fatalf("encoding the key: %v", err)
	}
	return map[string]json.RawMessage{"key": encodedKey, "value": value}
}

func stringValue(s string) json.RawMessage {
	encoded, _ := json.Marshal(map[string]string{"stringValue": s})
	return encoded
}

func TestEveryComparePrefillChecksInEachRecordContext(t *testing.T) {
	checked := 0
	for _, c := range comparePrefills(t) {
		if c.Condition == "" || (c.Quantifier != "all" && c.Quantifier != "none") {
			t.Errorf("%s: a case without its condition or Require: %+v", c.Name, c)
			continue
		}
		for _, sc := range prefillContexts {
			if problems := Check(sc.signal, ottlRule(sc.context, c.Quantifier, c.Condition), false, nil); len(problems) != 0 {
				t.Errorf("%s (%s): %v", c.Name, sc.context, problems)
			}
			checked++
		}
	}
	if checked < 42*3 {
		t.Errorf("checked %d conditions, want at least %d", checked, 42*3)
	}
}

// Each condition addresses its own key, and a changed one its own value:
// over one record holding the key (with the case's value), added and
// changed pass and removed fails; over one record holding the key with some
// other value, changed fails. A changed condition passes over each of the
// case's sameAs, the values the web's detection takes for the same (the
// double 2^53 over the int 2^53 + 1), and fails over each of differentFrom.
func TestEachComparePrefillTestsItsOwnKeyAndValue(t *testing.T) {
	for _, c := range comparePrefills(t) {
		value := c.Value
		if c.Kind != "changed" {
			value = stringValue("present")
		}
		for _, sc := range prefillContexts {
			output := oneRecord(t, sc.signal, []map[string]json.RawMessage{attribute(t, c.Key, value)})
			r := run(t, sc.signal, &output, "", ottlRule(sc.context, c.Quantifier, c.Condition))[0]
			if r.Error != nil {
				t.Errorf("%s (%s): the rule's error %q", c.Name, sc.context, *r.Error)
				continue
			}
			if want := c.Kind != "removed"; r.Passed != want {
				t.Errorf("%s (%s): over a record holding the key, passed %v, want %v", c.Name, sc.context, r.Passed, want)
			}
			if c.Kind != "changed" {
				continue
			}
			other := oneRecord(t, sc.signal, []map[string]json.RawMessage{attribute(t, c.Key, stringValue("__compare_prefills_other__"))})
			if r := run(t, sc.signal, &other, "", ottlRule(sc.context, c.Quantifier, c.Condition))[0]; r.Passed || r.Error != nil {
				t.Errorf("%s (%s): over a record holding another value, passed %v (error %q), want failed", c.Name, sc.context, r.Passed, errorOf(r))
			}
			for _, values := range []struct {
				list []json.RawMessage
				want bool
			}{{c.SameAs, true}, {c.DifferentFrom, false}} {
				for _, v := range values.list {
					record := oneRecord(t, sc.signal, []map[string]json.RawMessage{attribute(t, c.Key, v)})
					if r := run(t, sc.signal, &record, "", ottlRule(sc.context, c.Quantifier, c.Condition))[0]; r.Passed != values.want || r.Error != nil {
						t.Errorf("%s (%s): over a record holding %s, passed %v (error %q), want %v", c.Name, sc.context, v, r.Passed, errorOf(r), values.want)
					}
				}
			}
		}
	}
}

// The crafted key `x"] != nil or attributes["y` tests only itself: a record
// holding only x and y fails "added" and passes "removed", in each context.
// Left unescaped, the condition would test y and x, so "added" would
// pass.
func TestTheCraftedKeyTestsOnlyItself(t *testing.T) {
	const crafted = `x"] != nil or attributes["y`
	found := map[string]bool{}
	for _, c := range comparePrefills(t) {
		if c.Key != crafted || c.Kind == "changed" {
			continue
		}
		found[c.Kind] = true
		if !strings.HasPrefix(c.Condition, `attributes["x\"] != nil or attributes[\"y"]`) {
			t.Errorf("%s: the key isn't escaped: %s", c.Name, c.Condition)
		}
		for _, sc := range prefillContexts {
			output := oneRecord(t, sc.signal, []map[string]json.RawMessage{
				attribute(t, "x", stringValue("1")),
				attribute(t, "y", stringValue("2")),
			})
			r := run(t, sc.signal, &output, "", ottlRule(sc.context, c.Quantifier, c.Condition))[0]
			if want := c.Kind == "removed"; r.Passed != want || r.Error != nil {
				t.Errorf("%s (%s) over a record of x and y: passed %v (error %q), want passed %v", c.Name, sc.context, r.Passed, errorOf(r), want)
			}
		}
	}
	if !found["added"] || !found["removed"] {
		t.Fatalf("the fixture lacks the crafted key's added or removed case: %v", found)
	}
}

// OTTL compares an int and a double as float64(int) == double (compare.go),
// so the fixture holds the double 2^53 the int 2^53 + 1 equals, and the int
// 2^53 + 1 that the int 2^53 doesn't: the web's detection is pinned to it.
func TestTheFixtureHoldsTheIntAndDoubleCases(t *testing.T) {
	compact := func(raw json.RawMessage) string {
		var out bytes.Buffer
		if err := json.Compact(&out, raw); err != nil {
			t.Fatalf("compacting %s: %v", raw, err)
		}
		return out.String()
	}
	has := func(values []json.RawMessage, want string) bool {
		for _, v := range values {
			if compact(v) == want {
				return true
			}
		}
		return false
	}
	var double, integer bool
	for _, c := range comparePrefills(t) {
		if c.Kind != "changed" {
			continue
		}
		switch compact(c.Value) {
		case `{"doubleValue":9007199254740992}`:
			double = has(c.SameAs, `{"intValue":"9007199254740993"}`)
		case `{"intValue":"9007199254740993"}`:
			integer = has(c.SameAs, `{"doubleValue":9007199254740992}`) && has(c.DifferentFrom, `{"intValue":"9007199254740992"}`)
		}
	}
	if !double || !integer {
		t.Fatalf("the fixture lacks the 2^53 cases: the double's %v, the int's %v", double, integer)
	}
}
