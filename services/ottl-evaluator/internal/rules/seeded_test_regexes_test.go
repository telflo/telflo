// New in D15b Task 1 (plan Preflight ruling 2): every pattern the regex
// library is seeded with (migration 1700000000031's seededTestRegexes)
// passes a regex rule's own checks, the ones validate answers at Save, so a
// pattern picked from the library is a rule that saves. The fixture,
// testdata/seeded-test-regexes.json, is generated from the migration by
// `npm run fixture:seeded-test-regexes --workspace @telflo/db`, whose suite
// fails when it is stale.

package rules

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type seededTestRegex struct {
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Description *string `json:"description"`
	Regex       string  `json:"regex"`
}

func seededTestRegexes(t *testing.T) []seededTestRegex {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "seeded-test-regexes.json"))
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	var fixture struct {
		Description string            `json:"description"`
		Script      string            `json:"script"`
		TestRegexes []seededTestRegex `json:"testRegexes"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decoding the fixture: %v", err)
	}
	return fixture.TestRegexes
}

func TestEverySeededTestRegexPassesARegexRulesChecks(t *testing.T) {
	entries := seededTestRegexes(t)
	if len(entries) != 35 {
		t.Fatalf("the fixture holds %d entries, want 35", len(entries))
	}
	checked := 0
	for _, entry := range entries {
		if entry.Name == "" || entry.Regex == "" {
			t.Errorf("an entry without a name or a regex: %+v", entry)
			continue
		}
		for _, signal := range Signals {
			for _, kind := range []string{KindContainsRegex, KindNotContainsRegex} {
				for _, target := range []string{TargetOutput, TargetStderr} {
					regex := entry.Regex
					rule := Rule{ID: nextID(), Kind: kind, Target: target, Pattern: &regex}
					if problems := Check(signal, rule, false, nil); len(problems) != 0 {
						t.Errorf("%q (%s, %s, %s): %v", entry.Name, signal, kind, target, problems)
					}
					checked++
				}
			}
		}
	}
	if checked != 35*3*2*2 {
		t.Errorf("checked %d rules, want %d", checked, 35*3*2*2)
	}
}

// The checks the test leans on refuse a pattern RE2 can't compile, so a
// seeded pattern that stopped compiling would fail above.
func TestARegexRuleCheckRefusesWhatRE2CannotCompile(t *testing.T) {
	for _, pattern := range []string{`secret(?=:)`, `(abc`, `\d{3}-\d{2}-\d{4}\`} {
		rule := Rule{ID: nextID(), Kind: KindContainsRegex, Target: TargetOutput, Pattern: strPtr(pattern)}
		if problems := Check("logs", rule, false, nil); len(problems) != 1 || problems[0].Field != FieldPattern {
			t.Errorf("%q: problems %v, want one on the pattern", pattern, problems)
		}
	}
}
