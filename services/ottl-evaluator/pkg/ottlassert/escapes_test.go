package ottlassert

import (
	"strings"
	"testing"
)

func TestFindSuspiciousEscape(t *testing.T) {
	cases := []struct {
		name string
		expr string
		want string
	}{
		// The live incident: \b in the OTTL literal is a backspace char.
		{"single backslash b", `not IsMatch(body.string, "\b[0-9]{13,19}\b")`, `\b`},
		{"single backslash d", `IsMatch(body.string, "\d{4}")`, `\d`},
		{"single backslash w mid-pattern", `IsMatch(name, "user_\w+")`, `\w`},
		// Correct double escaping — regex \b reaches the engine.
		{"double backslash b", `not IsMatch(body.string, "\\b[0-9]{4}\\b")`, ""},
		{"double backslash d", `IsMatch(body.string, "\\d+")`, ""},
		// Escaped quote then clean pattern must not confuse the scanner.
		{"escaped quote", `body.string == "say \"hi\""`, ""},
		// \n is excluded: literal newline matches the same text as regex \n.
		{"newline escape allowed", `IsMatch(body.string, "line1\nline2")`, ""},
		// Odd run of three: last backslash escapes the letter.
		{"triple backslash b", `IsMatch(x, "\\\b")`, `\b`},
		// Quadruple: two literal backslashes, letter unescaped.
		{"quadruple backslash b", `IsMatch(x, "\\\\b")`, ""},
		{"no escapes at all", `attributes["env"] == "prod"`, ""},
		{"trailing backslash", `IsMatch(x, "abc\`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := findSuspiciousEscape(tc.expr); got != tc.want {
				t.Fatalf("findSuspiciousEscape(%q) = %q, want %q", tc.expr, got, tc.want)
			}
		})
	}
}

func TestLintFlagsSuspiciousEscape(t *testing.T) {
	res, err := Lint(ContextLog, []string{`not IsMatch(body.string, "\b[0-9]{4}\b")`}, nil, nil)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if res.Valid {
		t.Fatal("expected lint result to be invalid")
	}
	item := res.Items[0]
	if item.Valid {
		t.Fatal("expected condition item to be flagged invalid")
	}
	if !strings.Contains(item.Error, "single-escaped regex sequence") {
		t.Fatalf("unexpected error message: %s", item.Error)
	}
}

func TestLintAcceptsDoubleEscapedRegex(t *testing.T) {
	res, err := Lint(ContextLog, []string{`not IsMatch(body.string, "\\b[0-9]{4}\\b")`}, nil, nil)
	if err != nil {
		t.Fatalf("Lint returned error: %v", err)
	}
	if !res.Valid || !res.Items[0].Valid {
		t.Fatalf("expected double-escaped condition to lint clean, got %+v", res.Items[0])
	}
}

func TestRuleValidateRejectsSuspiciousEscape(t *testing.T) {
	rule := Rule{
		ID:         "r1",
		Context:    ContextLog,
		Condition:  `not IsMatch(body.string, "\b[0-9]{4}\b")`,
		Quantifier: QuantifierAll,
	}
	err := rule.validate(SignalLogs)
	if err == nil {
		t.Fatal("expected validate to reject single-escaped regex sequence")
	}
	if !strings.Contains(err.Error(), "single-escaped regex sequence") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// New in D15a's final fix wave (Ruling 55): the message is true of each
// sequence on the pinned OTTL. `\b` parses (a backspace) and Lint flags it;
// every other risky letter doesn't parse at all, so Lint reports the
// parser's own error, and the message (Save's, a run's: rule.validate and
// internal/rules check before parsing) asks for the double backslash.
func TestSuspiciousEscapeErrorIsTrueOfEachSequence(t *testing.T) {
	want := map[string]string{
		`\b`: `single-escaped regex sequence '\b': OTTL string literals consume one level of backslash escaping, so it becomes a literal backspace character and the pattern can never match — write '\\b' (double backslash) for the regex word boundary`,
		`\d`: `single-escaped regex sequence '\d': it isn't an OTTL string escape (OTTL string literals consume one level of backslash escaping), so the regex needs a double backslash — write '\\d'`,
	}
	for sequence, message := range want {
		if got := suspiciousEscapeError(sequence); got != message {
			t.Errorf("%s:\n got %s\nwant %s", sequence, got, message)
		}
	}
	for letter := range riskyEscapeLetters {
		sequence := `\` + string(letter)
		condition := `IsMatch(body.string, "x` + sequence + `y")`
		message := suspiciousEscapeError(sequence)
		if strings.Contains(message, "control character") {
			t.Errorf("%s: %s", sequence, message)
		}
		res, err := Lint(ContextLog, []string{condition}, nil, nil)
		if err != nil {
			t.Fatalf("%s: Lint: %v", sequence, err)
		}
		item := res.Items[0]
		if item.Valid {
			t.Fatalf("%s: Lint accepted %s", sequence, condition)
		}
		if letter == 'b' {
			if item.Error != message || !strings.Contains(message, "backspace") {
				t.Errorf(`\b parses as a backspace and is flagged: %q`, item.Error)
			}
			continue
		}
		if item.Error == message || strings.Contains(message, "backspace") || !strings.Contains(message, `'\\`+string(letter)+`'`) {
			t.Errorf("%s doesn't parse (%q); its message asks for the double backslash: %q", sequence, item.Error, message)
		}
	}
}
