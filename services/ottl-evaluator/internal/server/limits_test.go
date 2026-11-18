// New in D15a Task 2 (plan Preflight ruling 10): each cap refuses; past the
// in-flight cap the answer is busy, and the slot is taken before the body is
// read; the deadline ends an evaluation with "Not checked"; the hard kill
// reaps the child and frees the slot; a child killed for memory, one the Go
// runtime kills, one that crashes; validate's kill. No test sleeps: the
// timers are fake and fired by the test, and every wait is on a channel
// under the hang guard. D15a Task 3's follow-up (the controller's Ruling 34)
// pins validate's "too complex" wording by its literal text per field.

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

func TestEachCapRefuses(t *testing.T) {
	ts := newTestServer(t, withSettings(func(s *Settings) {
		s.MaxEvaluateBodyBytes = 1 << 20
		s.MaxValidateBodyBytes = 4 << 10
	}))
	output := "{}"
	rule := textRuleJSON("r1", "contains_text", "output", "x")
	manyRules := make([]string, rules.MaxRules+1)
	for i := range manyRules {
		manyRules[i] = textRuleJSON(fmt.Sprintf("r%d", i), "contains_text", "output", "x")
	}
	cases := []struct {
		name, target, body string
		status             int
		code               string
	}{
		{"evaluate body over its cap", evaluatePath, evaluateBody("logs", &output, strings.Repeat("x", 1<<20), rule), 413, codePayloadTooLarge},
		{"validate body over its cap", validatePath, `{"signal":"logs","rule":{"kind":"contains_text","target":"output","pattern":"` + strings.Repeat("x", 4<<10) + `"}}`, 413, codePayloadTooLarge},
		{"more than 200 rules", evaluatePath, evaluateBody("logs", &output, "", manyRules...), 400, codeInvalidRequest},
		{"no rules", evaluatePath, evaluateBody("logs", &output, ""), 400, codeInvalidRequest},
		{"two rules with one id", evaluatePath, evaluateBody("logs", &output, "", rule, rule), 400, codeInvalidRequest},
		{"a log over 262,144 characters", evaluatePath, evaluateBody("logs", &output, strings.Repeat("é", rules.MaxLogCharacters+1), rule), 400, codeInvalidRequest},
		{"a pattern over 8,192 characters", evaluatePath, evaluateBody("logs", &output, "", textRuleJSON("r1", "contains_text", "output", strings.Repeat("x", 8193))), 400, codeInvalidRequest},
		{"an empty pattern", evaluatePath, evaluateBody("logs", &output, "", textRuleJSON("r1", "contains_text", "output", "")), 400, codeInvalidRequest},
		{"an OTTL rule on the log", evaluatePath, evaluateBody("logs", &output, "", `{"id":"r1","kind":"ottl","target":"stderr","ottl":{"context":"log","quantifier":"all","condition":"true"}}`), 400, codeInvalidRequest},
		{"output that isn't base64", evaluatePath, `{"signal":"logs","output":{"base64":"!!!","truncated":false},"log":"","rules":[` + rule + `]}`, 400, codeInvalidRequest},
		{"an unknown signal", evaluatePath, evaluateBody("profiles", &output, "", rule), 400, codeInvalidRequest},
		{"an unknown member", evaluatePath, strings.Replace(evaluateBody("logs", &output, "", rule), `"log":`, `"extra":1,"log":`, 1), 400, codeInvalidRequest},
		{"a count's value negative", evaluatePath, evaluateBody("logs", &output, "", `{"id":"r1","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":-1}}}`), 400, codeInvalidRequest},
		{"a count's value a string", evaluatePath, evaluateBody("logs", &output, "", `{"id":"r1","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":"2"}}}`), 400, codeInvalidRequest},
		{"a count's value 2.5", evaluatePath, evaluateBody("logs", &output, "", `{"id":"r1","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":2.5}}}`), 400, codeInvalidRequest},
		{"a null pattern", evaluatePath, evaluateBody("logs", &output, "", `{"id":"r1","kind":"contains_text","target":"output","pattern":null}`), 400, codeInvalidRequest},
		{"a body that isn't JSON", evaluatePath, `{"signal":`, 400, codeInvalidRequest},
	}
	for _, c := range cases {
		rec := ts.post(c.target, c.body)
		if rec.Code != c.status || errorCode(t, rec) != c.code {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}

	// An output that decodes to more than 10 MiB (under a body cap that
	// lets it through).
	big := newTestServer(t)
	huge := strings.Repeat("x", rules.MaxOutputBytes+1)
	if rec := big.post(evaluatePath, evaluateBody("logs", &huge, "", rule)); rec.Code != 400 || errorCode(t, rec) != codeInvalidRequest {
		t.Errorf("an output over 10 MiB: %d %s", rec.Code, rec.Body.String())
	}
	exact := strings.Repeat("x", rules.MaxOutputBytes)
	if rec := big.post(evaluatePath, evaluateBody("logs", &exact, "", rule)); rec.Code != 200 {
		t.Errorf("an output of exactly 10 MiB: %d %s", rec.Code, rec.Body.String())
	}

	// A declared length over the cap is refused before anything is read.
	body := &recordingBody{r: strings.NewReader(strings.Repeat("x", 100))}
	req := httptest.NewRequest(http.MethodPost, evaluatePath, body)
	req.ContentLength = 2 << 20
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	rec := httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	if rec.Code != 413 || body.reads.Load() != 0 {
		t.Errorf("a declared length over the cap: %d, %d reads", rec.Code, body.reads.Load())
	}
	// A streamed body (no declared length) is stopped while it is read.
	req = httptest.NewRequest(http.MethodPost, evaluatePath, strings.NewReader(evaluateBody("logs", &output, strings.Repeat("x", 2<<20), rule)))
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	rec = httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	if rec.Code != 413 {
		t.Errorf("a streamed body over the cap: %d", rec.Code)
	}
	// Not JSON's media type.
	req = httptest.NewRequest(http.MethodPost, evaluatePath, strings.NewReader("{}"))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	rec = httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	if rec.Code != 400 || errorCode(t, rec) != codeInvalidRequest {
		t.Errorf("text/plain: %d", rec.Code)
	}
}

// The caps that are a rule's content: its error, the request answered.
func TestContentCapsAreARulesError(t *testing.T) {
	ts := newTestServer(t, withSettings(func(s *Settings) { s.MaxOutputObjects = 3 }))
	output := `{"records":[{"resourceLogs":[]},{"resourceLogs":[]},{"resourceLogs":[]}]}`
	body := evaluateBody("logs", &output, "",
		textRuleJSON("bytes", "contains_text", "output", strings.Repeat("é", 4097)),
		ottlRuleJSON("nesting", "log", "all", strings.Repeat("Concat([", 7)+`"a"`+strings.Repeat(`], "")`, 7)+` == "a"`),
		ottlRuleJSON("objects", "log", "all", "true"),
		textRuleJSON("text", "contains_text", "output", "resourceLogs"),
	)
	a := decodeAnswer(t, ts.post(evaluatePath, body))
	if !strings.Contains(resultError(a.Results[0]), "longer than 8,192 bytes") ||
		!strings.Contains(resultError(a.Results[1]), "more than 12 deep") ||
		resultError(a.Results[2]) != rules.OutputTooLarge ||
		!a.Results[3].Passed {
		t.Fatalf("%+v", a.Results)
	}
}

// startRequest serves a request in the background; the recorder arrives on
// the channel when it is answered.
func startRequest(ts *testServer, ctx context.Context, target, body string) <-chan *httptest.ResponseRecorder {
	done := make(chan *httptest.ResponseRecorder, 1)
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	go func() {
		rec := httptest.NewRecorder()
		ts.handler.ServeHTTP(rec, req)
		done <- rec
	}()
	return done
}

func await(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case rec := <-done:
		return rec
	case <-time.After(hangGuard):
		t.Fatal("the request wasn't answered")
		return nil
	}
}

func threeRules() (string, []string) {
	return evaluateBody("logs", strPtr(logsPayload), "",
		textRuleJSON("a", "contains_text", "output", "hello"),
		textRuleJSON("b", "contains_text", "output", "hello"),
		ottlRuleJSON("c", "log", "all", "true"),
	), []string{"a", "b", "c"}
}

// The hard kill ends the child's whole group at its limit, reaps it, answers
// each unfinished rule "Not checked", and only then frees the slot.
func TestTheHardKillReapsTheChildAndFreesTheSlot(t *testing.T) {
	ts := newTestServer(t, withChild(hangChild), withSettings(func(s *Settings) { s.MaxEvaluations = 1 }))
	body, ids := threeRules()
	done := startRequest(ts, context.Background(), evaluatePath, body)
	limit := ts.timers.next(t, ts.settings.EvaluateHardDeadline)
	pid := ts.pid(t)
	if ts.evaluations.inUse() != 1 {
		t.Fatalf("%d slots in use while the child runs", ts.evaluations.inUse())
	}
	limit.fire()
	a := decodeAnswer(t, await(t, done))
	for i, r := range a.Results {
		if r.ID != ids[i] || r.Passed || resultError(r) != rules.NotCheckedDeadline || r.Detail != nil && string(r.Detail) != "null" {
			t.Errorf("result %d: %+v", i, r)
		}
	}
	if !reaped(pid) {
		t.Errorf("child %d wasn't reaped", pid)
	}
	if ts.evaluations.inUse() != 0 {
		t.Errorf("the slot wasn't freed")
	}
}

// The deadline inside the child (its checkpoints, the evaluate-child's soft
// deadline) ends the work: with it already past, the child stops before its
// first rule and every rule is "Not checked". internal/rules' tests stop it
// inside a record loop with a counting checkpoint.
func TestTheDeadlineEndsAnEvaluationWithNotChecked(t *testing.T) {
	ts := newTestServer(t, withSettings(func(s *Settings) { s.EvaluateSoftDeadline = 0 }))
	body, ids := threeRules()
	a := decodeAnswer(t, ts.post(evaluatePath, body))
	for i, r := range a.Results {
		if r.ID != ids[i] || r.Passed || resultError(r) != rules.NotCheckedDeadline {
			t.Errorf("result %d: %+v", i, r)
		}
	}
}

func TestAChildKilledForMemoryKeepsWhatItFinished(t *testing.T) {
	for _, child := range []string{memoryKillChild, runtimeOOMChild} {
		ts := newTestServer(t, withChild(child))
		body, ids := threeRules()
		a := decodeAnswer(t, ts.post(evaluatePath, body))
		for i, r := range a.Results {
			finished := child == memoryKillChild && i == 0
			switch {
			case r.ID != ids[i]:
				t.Errorf("%s: result %d is %s's", child, i, r.ID)
			case finished && (!r.Passed || r.Error != nil):
				t.Errorf("%s: the finished rule lost its result: %+v", child, r)
			case !finished && resultError(r) != rules.NotCheckedMemory:
				t.Errorf("%s: result %d: %+v", child, i, r)
			}
		}
	}
}

func TestAChildThatCrashesIsAnInternalError(t *testing.T) {
	ts := newTestServer(t, withChild(crashChild))
	body, _ := threeRules()
	rec := ts.post(evaluatePath, body)
	if rec.Code != 500 || errorCode(t, rec) != codeInternalError {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec := ts.post(validatePath, `{"signal":"logs","rule":{"kind":"contains_regex","target":"output","pattern":"x"}}`); rec.Code != 500 {
		t.Fatalf("validate: %d", rec.Code)
	}
}

// Past the cap the answer is busy, after the wait, without reading the
// body: the slot is taken first.
func TestBusyPastTheCap(t *testing.T) {
	ts := newTestServer(t, withChild(hangChild), withSettings(func(s *Settings) { s.MaxEvaluations = 1 }))
	body, _ := threeRules()
	first := startRequest(ts, context.Background(), evaluatePath, body)
	firstLimit := ts.timers.next(t, ts.settings.EvaluateHardDeadline)
	ts.pid(t)

	// The second waits for a slot; its wait runs out.
	waiting := &recordingBody{r: strings.NewReader(body)}
	req := httptest.NewRequest(http.MethodPost, evaluatePath, waiting)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		ts.handler.ServeHTTP(rec, req)
		second <- rec
	}()
	ts.timers.next(t, ts.settings.EvaluateWait).fire()
	rec := await(t, second)
	if rec.Code != 503 || errorCode(t, rec) != codeEvaluatorBusy || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("past the cap: %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}
	if waiting.reads.Load() != 0 {
		t.Fatalf("a busy request's body was read %d times", waiting.reads.Load())
	}

	// A third waits, and gets the slot when the first frees it.
	third := startRequest(ts, context.Background(), evaluatePath, body)
	thirdWait := ts.timers.next(t, ts.settings.EvaluateWait)
	firstLimit.fire()
	if rec := await(t, first); rec.Code != 200 {
		t.Fatalf("the first: %d", rec.Code)
	}
	thirdLimit := ts.timers.next(t, ts.settings.EvaluateHardDeadline)
	ts.pid(t)
	thirdLimit.fire()
	thirdWait.fire() // too late to matter: it has its slot
	if rec := await(t, third); rec.Code != 200 {
		t.Fatalf("the third: %d %s", rec.Code, rec.Body.String())
	}

	// Validations have their own cap.
	vs := newTestServer(t, withChild(hangChild), withSettings(func(s *Settings) { s.MaxValidations = 1 }))
	validation := `{"signal":"logs","rule":{"kind":"contains_regex","target":"output","pattern":"x"}}`
	held := startRequest(vs, context.Background(), validatePath, validation)
	heldLimit := vs.timers.next(t, vs.settings.ValidateHardDeadline)
	vs.pid(t)
	busy := startRequest(vs, context.Background(), validatePath, validation)
	vs.timers.next(t, vs.settings.ValidateWait).fire()
	if rec := await(t, busy); rec.Code != 503 || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("validate past its cap: %d", rec.Code)
	}
	heldLimit.fire()
	await(t, held)
}

// A request that ends (its client gone) kills its child and frees its slot.
func TestARequestThatEndsKillsItsChild(t *testing.T) {
	ts := newTestServer(t, withChild(hangChild))
	body, _ := threeRules()
	ctx, cancel := context.WithCancel(context.Background())
	done := startRequest(ts, ctx, evaluatePath, body)
	pid := ts.pid(t)
	cancel()
	if rec := await(t, done); rec.Code != 500 {
		t.Fatalf("%d", rec.Code)
	}
	if !reaped(pid) || ts.evaluations.inUse() != 0 {
		t.Fatalf("reaped %v, %d slots in use", reaped(pid), ts.evaluations.inUse())
	}
}

func TestValidateKilledAtItsLimitIsTooComplex(t *testing.T) {
	for _, c := range []struct {
		child, rule, field, message string
	}{
		{hangChild, `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"true"}}`, rules.FieldCondition, "The condition is too complex to check."},
		{hangChild, `{"kind":"contains_regex","target":"output","pattern":"x"}`, rules.FieldPattern, "The pattern is too complex to check."},
		{hangCheckingChild, `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"distinct","expression":"body","count":{"operator":"eq","value":1}}}`, rules.FieldExpression, "The expression is too complex to check."},
	} {
		ts := newTestServer(t, withChild(c.child))
		done := startRequest(ts, context.Background(), validatePath, `{"signal":"logs","rule":`+c.rule+`}`)
		limit := ts.timers.next(t, ts.settings.ValidateHardDeadline)
		pid := ts.pid(t)
		limit.fire()
		rec := await(t, done)
		var a struct {
			Valid    bool            `json:"valid"`
			Problems []rules.Problem `json:"problems"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil || rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		if a.Valid || len(a.Problems) != 1 || a.Problems[0].Message != c.message || a.Problems[0].Field != c.field {
			t.Errorf("%s: %s", c.rule, rec.Body.String())
		}
		if !reaped(pid) || ts.validations.inUse() != 0 {
			t.Errorf("reaped %v, %d slots", reaped(pid), ts.validations.inUse())
		}
	}
}

// The real slow parse the preflight measured (`Concat([` twenty deep, 37 s)
// never reaches the parser: its nesting is refused first.
func TestTheSlowParseIsRefusedByItsNesting(t *testing.T) {
	ts := newTestServer(t)
	condition := strings.Repeat("Concat([", 20)
	rec := ts.post(validatePath, `{"signal":"logs","rule":{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":`+jsonQuote(condition)+`}}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "more than 12 deep") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// The log carries the method, the route's pattern, the status and the
// duration, and nothing of a request: no secret, rule, output, log, message
// or path.
func TestLogsCarryNoRequestContent(t *testing.T) {
	ts := newTestServer(t)
	marker := "MARKER-7f3a"
	output := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"` + marker + `-output"}}]}]}]}`
	ts.post(evaluatePath, evaluateBody("logs", &output, marker+"-log",
		textRuleJSON("r1", "not_contains_text", "output", marker),
		ottlRuleJSON("r2", "log", "all", `body == "`+marker+`-condition"`),
		textRuleJSON("r3", "contains_regex", "output", "("+marker),
	))
	ts.post(validatePath, `{"signal":"logs","rule":{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"`+marker+`("}}}`)
	ts.post(evaluatePath, `{"`+marker+`":1}`)
	ts.call(http.MethodGet, "/"+marker+"/path?"+marker+"=1", "", "")
	ts.call(http.MethodGet, "/"+marker, "", testSecret)
	ts.call(http.MethodPost, evaluatePath, "{}", marker)
	ts.call(http.MethodGet, healthPath, "", "")

	logs := ts.logs.String()
	for _, secret := range []string{marker, testSecret, previousSecret, "Bearer"} {
		if strings.Contains(logs, secret) {
			t.Fatalf("the log holds %q:\n%s", secret, logs)
		}
	}
	// GET /health writes no line (D33-1 decision 18, Ruling 335).
	lines := strings.Split(strings.TrimSpace(logs), "\n")
	if len(lines) != 6 {
		t.Fatalf("%d log lines:\n%s", len(lines), logs)
	}
	routes := []string{"POST /ottl/v1/evaluate", "POST /ottl/v1/validate", "POST /ottl/v1/evaluate", "unmatched", "unmatched", "POST /ottl/v1/evaluate"}
	for i, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		for key := range entry {
			switch key {
			case "time", "level", "msg", "method", "route", "status", "durationMs":
			default:
				t.Errorf("line %d has %q: %s", i, key, line)
			}
		}
		if entry["route"] != routes[i] {
			t.Errorf("line %d: route %v, want %s", i, entry["route"], routes[i])
		}
	}
}

// An input much larger than a pipe's buffer reaches the child whole.
func TestALargeInputReachesTheChild(t *testing.T) {
	ts := newTestServer(t)
	output := `{"resourceLogs":[{"scopeLogs":[{"logRecords":[` + strings.TrimSuffix(strings.Repeat(`{"body":{"stringValue":"x"}},`, 20000), ",") + `]}]}]}`
	body := evaluateBody("logs", &output, strings.Repeat("y", 200000),
		`{"id":"n","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":20000}}}`)
	a := decodeAnswer(t, ts.post(evaluatePath, body))
	if !a.Results[0].Passed {
		t.Fatalf("%+v", a.Results[0])
	}
}
