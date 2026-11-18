// The text and regex rules' cases, and S4's pathological regexes (D15a
// decision 2; plan Preflight ruling 14):
//
//   - the retired and unknown kinds are refused by the request's shape (400):
//     internal/server's TestRetiredAndUnknownKindsAreRefused;
//   - a match names its record (the element of the output and a JSON path,
//     or the log's line) and its context on the line;
//   - a regex that doesn't compile is "Invalid regex: …";
//   - text rules search the output's bytes as they are, whitespace-tolerant;
//   - S4's two-second wall-clock bound is the suite's hang guard: Go's
//     regexp, like RE2, is linear.

package rules

import (
	"strings"
	"testing"
)

// test_contains_text_passes_when_substring_present
func TestContainsTextPassesWhenSubstringPresent(t *testing.T) {
	r := one(t, `{"a": "hello world"}`, textRule(KindContainsText, "hello"))
	if !r.Passed || r.Error != nil {
		t.Fatalf("want passed with no error: %+v", r)
	}
}

// test_not_contains_text_fails_when_substring_present
func TestNotContainsTextFailsWhenSubstringPresent(t *testing.T) {
	r := one(t, `{"a": "hello world"}`, textRule(KindNotContainsText, "hello"))
	if r.Passed {
		t.Fatalf("want failed: %+v", r)
	}
}

// test_contains_regex_passes_on_match
func TestContainsRegexPassesOnMatch(t *testing.T) {
	r := one(t, `{"msg": "error: boom"}`, textRule(KindContainsRegex, `^.*error:.*$`))
	if !r.Passed {
		t.Fatalf("want passed: %+v", r)
	}
}

// test_invalid_regex_returns_error_message
func TestInvalidRegexReturnsErrorMessage(t *testing.T) {
	r := one(t, "anything", textRule(KindContainsRegex, "(unclosed"))
	if r.Passed || !strings.Contains(errorOf(r), "Invalid regex") {
		t.Fatalf("want failed with an invalid regex error: %+v", r)
	}
}

// test_stderr_target_reads_from_stderr_not_output
func TestStderrTargetReadsFromStderrNotOutput(t *testing.T) {
	r := oneLog(t, `{"records": [{"a": 1}]}`, "ERROR: ottl: failed to parse statement: invalid syntax\n",
		stderrRule(KindContainsText, "failed to parse statement"))
	if !r.Passed {
		t.Fatalf("want passed: %+v", r)
	}
}

// test_stderr_target_not_contains_text_catches_silent_drops
func TestStderrTargetNotContainsTextCatchesSilentDrops(t *testing.T) {
	r := oneLog(t, "{}", "memory_limiter dropped 1500 data points\nmemory_limiter dropped 1200 data points\n",
		stderrRule(KindNotContainsText, "dropped"))
	if r.Passed {
		t.Fatalf("want failed: %+v", r)
	}
}

// test_stderr_target_with_regex_matches_error_severity_levels
func TestStderrTargetWithRegexMatchesErrorSeverityLevels(t *testing.T) {
	r := oneLog(t, "{}", "INFO: started\nERROR: exporter rejected: InvalidArgument\n",
		stderrRule(KindNotContainsRegex, `ERROR|FATAL`))
	if r.Passed {
		t.Fatalf("want failed: %+v", r)
	}
}

// test_output_target_ignores_stderr_content
func TestOutputTargetIgnoresStderrContent(t *testing.T) {
	r := oneLog(t, `{"records": []}`, "this stderr line contains the substring fooBARbaz",
		textRule(KindContainsText, "fooBARbaz"))
	if r.Passed {
		t.Fatalf("an output rule read the log: %+v", r)
	}
}

// test_stderr_target_with_empty_stderr_passes_not_contains
func TestStderrTargetWithEmptyStderrPassesNotContains(t *testing.T) {
	r := oneLog(t, "{}", "", stderrRule(KindNotContainsText, "ERROR"))
	if !r.Passed {
		t.Fatalf("want passed: %+v", r)
	}
}

// test_evaluate_rules_stderr_kwarg_defaults_to_empty_string: the request
// always carries the log, so its absence is an empty log.
func TestEmptyLogLeavesOutputRulesAlone(t *testing.T) {
	output := "hello"
	results := run(t, "logs", &output, "",
		textRule(KindContainsText, "hello"),
		stderrRule(KindNotContainsText, "anything"))
	if !results[0].Passed {
		t.Errorf("the output rule should pass: %+v", results[0])
	}
	if !results[1].Passed {
		t.Errorf("an empty log doesn't contain anything: %+v", results[1])
	}
}

// test_contains_text_no_match_attaches_failure_detail
func TestContainsTextNoMatchAttachesFailureDetail(t *testing.T) {
	r := one(t, "abc\ndef\nghi", textRule(KindContainsText, "xyz"))
	if r.Passed {
		t.Fatalf("want failed: %+v", r)
	}
	d := detailOf(t, r)
	if d.Kind != "no_match" || d.Source != "output" || d.SearchedCharacters != 11 {
		t.Fatalf("detail: %+v", d)
	}
	// no_match carries exactly its three members (no empty matches list,
	// no zero count).
	if keys := detailKeys(t, r); len(keys) != 3 {
		t.Fatalf("no_match has members %v", keys)
	}
}

// test_not_contains_text_records_match_positions: line 1 column 7 and line
// 3 column 1 became each match's context on its line (and, in the log, its
// line).
func TestNotContainsTextRecordsMatchPositions(t *testing.T) {
	text := "line1 hit\nline2\nhit again\n"
	for _, rule := range []Rule{textRule(KindNotContainsText, "hit"), stderrRule(KindNotContainsText, "hit")} {
		r := oneLog(t, text, text, rule)
		if r.Passed {
			t.Fatalf("want failed: %+v", r)
		}
		d := detailOf(t, r)
		if d.Kind != "unexpected_match" || d.TotalMatchCount != 2 || len(d.Matches) != 2 {
			t.Fatalf("detail: %+v", d)
		}
		first, second := d.Matches[0], d.Matches[1]
		if first.Text != "hit" || first.Before != "line1 " || first.After != "" {
			t.Errorf("first match: %+v", first)
		}
		if second.Text != "hit" || second.Before != "" || second.After != " again" {
			t.Errorf("second match: %+v", second)
		}
		if rule.Target == TargetStderr {
			if first.Record["line"] != float64(1) || second.Record["line"] != float64(3) {
				t.Errorf("lines: %v, %v", first.Record, second.Record)
			}
		} else if first.Record["index"] != nil || second.Record["index"] != nil {
			// The output isn't JSON, so no record holds the matches.
			t.Errorf("records of a non-JSON output: %v, %v", first.Record, second.Record)
		}
	}
}

// test_not_contains_text_caps_matches_at_five
func TestNotContainsTextCapsMatchesAtFive(t *testing.T) {
	r := one(t, strings.Repeat("hit ", 8), textRule(KindNotContainsText, "hit"))
	d := detailOf(t, r)
	if r.Passed || len(d.Matches) != 5 || d.TotalMatchCount != 8 || d.MoreMatches {
		t.Fatalf("want 5 of 8 matches shown: passed=%v %+v", r.Passed, d)
	}
}

// test_contains_regex_no_match_attaches_failure_detail
func TestContainsRegexNoMatchAttachesFailureDetail(t *testing.T) {
	out := "hello world"
	r := one(t, out, textRule(KindContainsRegex, `error: \d+`))
	d := detailOf(t, r)
	if r.Passed || d.Kind != "no_match" || d.SearchedCharacters != len(out) {
		t.Fatalf("passed=%v %+v", r.Passed, d)
	}
}

// test_not_contains_regex_unexpected_match_uses_group_zero
func TestNotContainsRegexUnexpectedMatchUsesGroupZero(t *testing.T) {
	r := one(t, "trace 42 trace 99", textRule(KindNotContainsRegex, `trace \d+`))
	d := detailOf(t, r)
	if r.Passed || d.Kind != "unexpected_match" || d.TotalMatchCount != 2 {
		t.Fatalf("passed=%v %+v", r.Passed, d)
	}
	if len(d.Matches) != 2 || d.Matches[0].Text != "trace 42" || d.Matches[1].Text != "trace 99" {
		t.Fatalf("matches: %+v", d.Matches)
	}
}

// test_failure_detail_marks_stderr_source
func TestFailureDetailMarksStderrSource(t *testing.T) {
	r := oneLog(t, "{}", "ERROR boom\n", stderrRule(KindNotContainsRegex, "ERROR"))
	if d := detailOf(t, r); r.Passed || d.Source != "stderr" {
		t.Fatalf("passed=%v %+v", r.Passed, d)
	}
}

// test_failure_match_context_clamps_to_current_line
func TestFailureMatchContextClampsToCurrentLine(t *testing.T) {
	r := one(t, "prefix hit\nthe next line continues here", textRule(KindNotContainsText, "hit"))
	m := detailOf(t, r).Matches[0]
	if strings.Contains(m.Before, "\n") || strings.Contains(m.After, "\n") {
		t.Fatalf("context crosses a newline: %+v", m)
	}
	if m.After != "" {
		t.Fatalf("the match ends right before the newline, so nothing comes after it: %q", m.After)
	}
}

// test_invalid_regex_uses_error_message_not_failure_detail
func TestInvalidRegexUsesErrorMessageNotFailureDetail(t *testing.T) {
	r := one(t, "anything", textRule(KindContainsRegex, "(unclosed"))
	if r.Passed || !strings.Contains(errorOf(r), "Invalid regex") || !noDetail(r) {
		t.Fatalf("%+v", r)
	}
}

// test_passing_rule_leaves_failure_detail_null
func TestPassingRuleLeavesFailureDetailNull(t *testing.T) {
	r := one(t, "hello world", textRule(KindContainsText, "hello"))
	if !r.Passed || !noDetail(r) || r.Error != nil {
		t.Fatalf("%+v", r)
	}
}

// test_zero_width_regex_marks_failure_without_recording_spans
func TestZeroWidthRegexMarksFailureWithoutRecordingSpans(t *testing.T) {
	r := one(t, "bbb", textRule(KindNotContainsRegex, "a*"))
	if r.Passed || !noDetail(r) || r.Error != nil {
		t.Fatalf("want failed with no detail: %+v", r)
	}
	// New in D15a (Ruling 55): the advisory says why (TestOnlyEmptyMatchesFailWithAnAdvisory).
	if want := "The pattern matched only empty text (4 times), so there is no match to show."; advisoryOf(r) != want {
		t.Fatalf("advisory %q, want %q", advisoryOf(r), want)
	}
}

// test_long_match_text_is_truncated
func TestLongMatchTextIsTruncated(t *testing.T) {
	r := one(t, strings.Repeat("x", 1000), textRule(KindNotContainsRegex, `x.*`))
	m := detailOf(t, r).Matches[0]
	if len(m.Text) != 200 || !m.TextTruncated {
		t.Fatalf("text %d bytes, truncated %v", len(m.Text), m.TextTruncated)
	}
}

// S4, test_pathological_regex_returns_quickly: (a+)+b over a's and no b. Its
// two-second wall-clock bound is the suite's hang guard (Go's regexp is
// linear); the input is 30 a's and a long run too.
func TestPathologicalRegexReturnsQuickly(t *testing.T) {
	for _, payload := range []string{strings.Repeat("a", 30), strings.Repeat("a", 1<<20)} {
		r := one(t, payload, textRule(KindContainsRegex, `(a+)+b`))
		if r.Passed || r.Error != nil {
			t.Fatalf("no b, so no match: %+v", r)
		}
	}
}

// S4, test_contains_regex_rejects_lookaround_via_re2
func TestContainsRegexRejectsLookaround(t *testing.T) {
	r := one(t, "bar", textRule(KindContainsRegex, "(?=foo)bar"))
	if r.Passed || !strings.Contains(strings.ToLower(errorOf(r)), "regex") {
		t.Fatalf("want a regex error: %+v", r)
	}
}

// S4, test_valid_regex_still_works_through_re2
func TestValidRegexStillWorks(t *testing.T) {
	r := one(t, "hello   world", textRule(KindContainsRegex, `hello\s+world`))
	if !r.Passed {
		t.Fatalf("want passed: %+v", r)
	}
}
