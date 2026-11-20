// POST /ottl/v1/lint. Each text's verdict in order, no text echoed; the
// 200-text cap; the secret; the validations' slots it shares; the nesting
// guard before the parse; the hard deadline's "Not checked" for the items
// not reached, the child reaped and the slot freed. No test sleeps: the
// timers are fake and fired by the test.

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

type lintReply struct {
	OTTLVersion string              `json:"ottlVersion"`
	Items       []rules.LintVerdict `json:"items"`
}

func decodeLintReply(t *testing.T, rec *httptest.ResponseRecorder) lintReply {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var reply lintReply
	if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil {
		t.Fatalf("answer: %v", err)
	}
	return reply
}

func verdictError(v rules.LintVerdict) string {
	if v.Error == nil {
		return ""
	}
	return *v.Error
}

// lintBody builds a lint request of one kind's texts.
func lintBody(context, member string, texts ...string) string {
	quoted := make([]string, len(texts))
	for i, text := range texts {
		quoted[i] = jsonQuote(text)
	}
	return `{"context":"` + context + `","` + member + `":[` + strings.Join(quoted, ",") + `]}`
}

func TestLintAnswersEachTextsVerdictInOrderWithoutTheText(t *testing.T) {
	ts := newTestServer(t)
	marker := "MARKER-1c9e"
	body := `{"context":"log",` +
		`"valueExpressions":["body",` + jsonQuote(`attributes["`+marker) + `],` +
		`"statements":[` + jsonQuote(`set(attributes["env"], "`+marker+`")`) + `,"convert_sum_to_gauge()"],` +
		`"conditions":[` + jsonQuote(`severity_number >= 17`) + `,` + jsonQuote(`attributes["`+marker) + `,"  ",` + jsonQuote(`IsMatch(body, "\d+")`) + `]}`
	reply := decodeLintReply(t, ts.post(lintPath, body))
	if reply.OTTLVersion == "" {
		t.Error("no ottlVersion")
	}
	want := []struct {
		kind  string
		index int
		valid bool
		error string
	}{
		{"condition", 0, true, ""},
		{"condition", 1, false, rules.SyntaxErrorPrefix},
		{"condition", 2, false, "The condition is empty."},
		{"condition", 3, false, "single-escaped regex sequence '\\d'"},
		{"statement", 0, true, ""},
		// The transform processor's own functions aren't registered: the
		// API turns this one into a note, by these words.
		{"statement", 1, false, `undefined function "convert_sum_to_gauge"`},
		{"valueExpression", 0, true, ""},
		{"valueExpression", 1, false, rules.SyntaxErrorPrefix},
	}
	if len(reply.Items) != len(want) {
		t.Fatalf("%d items: %+v", len(reply.Items), reply.Items)
	}
	for i, w := range want {
		got := reply.Items[i]
		if got.Kind != w.kind || got.Index != w.index || got.Valid != w.valid || !strings.Contains(verdictError(got), w.error) ||
			(w.valid && got.Error != nil) {
			t.Errorf("item %d: %+v (error %q), want %+v", i, got, verdictError(got), w)
		}
	}
	// The raw reply names no member but the contract's, and quotes no text
	// but a parser's own message about it.
	var raw struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(ts.post(lintPath, lintBody("log", "statements", `set(attributes["env"], "`+marker+`")`)).Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, item := range raw.Items {
		for key := range item {
			if key != "kind" && key != "index" && key != "valid" && key != "error" {
				t.Errorf("an item has %q", key)
			}
		}
		if strings.Contains(fmt.Sprint(item), marker) {
			t.Errorf("a valid item echoes its text: %v", item)
		}
	}
	if strings.Contains(ts.logs.String(), marker) {
		t.Errorf("the log holds a text:\n%s", ts.logs.String())
	}
}

func TestLintTakesAtMost200Texts(t *testing.T) {
	ts := newTestServer(t)
	texts := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = fmt.Sprintf(`attributes["k%d"] == "v"`, i)
		}
		return out
	}
	reply := decodeLintReply(t, ts.post(lintPath, lintBody("span", "conditions", texts(200)...)))
	if len(reply.Items) != 200 || !reply.Items[199].Valid || reply.Items[199].Index != 199 {
		t.Fatalf("200 texts: %d items, last %+v", len(reply.Items), reply.Items[len(reply.Items)-1])
	}
	for _, c := range []struct{ name, body string }{
		{"201 conditions", lintBody("span", "conditions", texts(201)...)},
		{"200 conditions and a statement", `{"context":"span","conditions":[` + strings.TrimSuffix(strings.Repeat(`"true",`, 200), ",") +
			`],"statements":["set(name, \"x\")"]}`},
		{"no text", `{"context":"span"}`},
		{"empty arrays", `{"context":"span","conditions":[],"statements":[]}`},
		{"an unknown context", lintBody("trace", "conditions", "true")},
		{"a text over 8,192 characters", lintBody("log", "conditions", strings.Repeat("x", 8193))},
		{"a text that isn't a string", `{"context":"log","conditions":[1]}`},
		{"an unknown member", `{"context":"log","conditions":["true"],"yaml":"a: 1"}`},
	} {
		if rec := ts.post(lintPath, c.body); rec.Code != 400 || errorCode(t, rec) != codeInvalidRequest {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
	// 8,192 characters of two bytes each is the item's error, not the request's.
	reply = decodeLintReply(t, ts.post(lintPath, lintBody("log", "conditions", strings.Repeat("é", 4097))))
	if reply.Items[0].Valid || !strings.Contains(verdictError(reply.Items[0]), "longer than 8,192 bytes") {
		t.Fatalf("%+v", reply.Items[0])
	}
}

func TestLintNeedsTheSecret(t *testing.T) {
	ts := newTestServer(t)
	body := lintBody("log", "conditions", "true")
	for _, token := range []string{"", "not-the-secret"} {
		if rec := ts.call(http.MethodPost, lintPath, body, token); rec.Code != 401 || errorCode(t, rec) != codeUnauthorized {
			t.Errorf("token %q: %d %s", token, rec.Code, rec.Body.String())
		}
	}
	if rec := ts.call(http.MethodPost, lintPath, body, previousSecret); rec.Code != 200 {
		t.Errorf("the previous secret: %d %s", rec.Code, rec.Body.String())
	}
	if rec := ts.call(http.MethodGet, lintPath, "", testSecret); rec.Code != 405 || rec.Header().Get("Allow") != http.MethodPost {
		t.Errorf("GET: %d %v", rec.Code, rec.Header())
	}
}

// Lint holds one of the validations' slots: past them it is busy, its body
// unread; a lint in flight makes a validation wait too.
func TestLintSharesTheValidationsPool(t *testing.T) {
	ts := newTestServer(t, withChild(hangChild), withSettings(func(s *Settings) { s.MaxValidations = 1 }))
	held := startRequest(ts, context.Background(), lintPath, lintBody("log", "conditions", "true"))
	heldLimit := ts.timers.next(t, ts.settings.LintHardDeadline)
	ts.pid(t)
	if ts.validations.inUse() != 1 || ts.evaluations.inUse() != 0 {
		t.Fatalf("validations %d, evaluations %d in use", ts.validations.inUse(), ts.evaluations.inUse())
	}

	waiting := &recordingBody{r: strings.NewReader(lintBody("log", "conditions", "true"))}
	req := httptest.NewRequest(http.MethodPost, lintPath, waiting)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testSecret)
	busy := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		ts.handler.ServeHTTP(rec, req)
		busy <- rec
	}()
	ts.timers.next(t, ts.settings.ValidateWait).fire()
	if rec := await(t, busy); rec.Code != 503 || errorCode(t, rec) != codeEvaluatorBusy || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("a second lint: %d %s", rec.Code, rec.Body.String())
	}
	if waiting.reads.Load() != 0 {
		t.Fatalf("a busy lint's body was read %d times", waiting.reads.Load())
	}

	validation := startRequest(ts, context.Background(), validatePath, `{"signal":"logs","rule":{"kind":"contains_regex","target":"output","pattern":"x"}}`)
	ts.timers.next(t, ts.settings.ValidateWait).fire()
	if rec := await(t, validation); rec.Code != 503 {
		t.Fatalf("a validation while a lint holds the slot: %d", rec.Code)
	}
	heldLimit.fire()
	await(t, held)
	if ts.validations.inUse() != 0 {
		t.Fatal("the slot wasn't freed")
	}
}

// The slow parse (`Concat([` twenty deep, 37 s) never reaches the parser:
// the nesting guard refuses it first, so the lint answers at once and well
// inside its deadline.
func TestLintRefusesDeepNestingBeforeTheParse(t *testing.T) {
	ts := newTestServer(t)
	deep := strings.Repeat("Concat([", 20)
	twelve := strings.Repeat("Concat([", 6) + `"a"` + strings.Repeat(`], "")`, 6) + ` == "a"`
	reply := decodeLintReply(t, ts.post(lintPath, `{"context":"log","conditions":[`+jsonQuote(deep)+`,`+jsonQuote(twelve)+`],"statements":[`+jsonQuote(deep)+`]}`))
	if reply.Items[0].Valid || verdictError(reply.Items[0]) != "The condition nests brackets more than 12 deep." {
		t.Errorf("condition: %+v", reply.Items[0])
	}
	if !reply.Items[1].Valid {
		t.Errorf("twelve deep: %+v (%s)", reply.Items[1], verdictError(reply.Items[1]))
	}
	if reply.Items[2].Valid || verdictError(reply.Items[2]) != "The statement nests brackets more than 12 deep." {
		t.Errorf("statement: %+v", reply.Items[2])
	}
}

// At the hard deadline the child's group is killed and reaped; the items it
// finished keep their verdicts, the others are "Not checked", and only then
// is the slot freed.
func TestLintKilledAtItsDeadlineAnswersNotChecked(t *testing.T) {
	for _, c := range []struct {
		child    string
		finished int
	}{{lintOneThenHangChild, 1}, {hangChild, 0}} {
		// The stand-in that finishes a text says so on a FIFO once its line is
		// written, so the limit fires only after it.
		written := make(chan string, 1)
		option := withChild(c.child)
		if c.child == lintOneThenHangChild {
			fifo := filepath.Join(t.TempDir(), "written")
			if err := syscall.Mkfifo(fifo, 0o600); err != nil {
				t.Fatal(err)
			}
			go readFIFO(fifo, written, make(chan bool, 1))
			option = func(_ *Settings, o *Options) {
				self, _ := os.Executable()
				o.ChildCommand = []string{self, lintOneThenHangChild, fifo}
			}
		} else {
			written <- "written\n"
		}
		ts := newTestServer(t, option)
		done := startRequest(ts, context.Background(), lintPath, `{"context":"log","conditions":["true","false"],"valueExpressions":["body"]}`)
		limit := ts.timers.next(t, ts.settings.LintHardDeadline)
		pid := ts.pid(t)
		select {
		case line := <-written:
			if line != "written\n" {
				t.Fatalf("%s: the FIFO said %q", c.child, line)
			}
		case <-time.After(hangGuard):
			t.Fatalf("%s: the child never wrote its line", c.child)
		}
		if ts.validations.inUse() != 1 {
			t.Fatalf("%s: %d slots in use while the child runs", c.child, ts.validations.inUse())
		}
		limit.fire()
		reply := decodeLintReply(t, await(t, done))
		kinds := []string{"condition", "condition", "valueExpression"}
		indexes := []int{0, 1, 0}
		if len(reply.Items) != 3 {
			t.Fatalf("%s: %+v", c.child, reply.Items)
		}
		for i, item := range reply.Items {
			finished := i < c.finished
			switch {
			case item.Kind != kinds[i] || item.Index != indexes[i]:
				t.Errorf("%s: item %d is %s %d", c.child, i, item.Kind, item.Index)
			case finished && (!item.Valid || item.Error != nil):
				t.Errorf("%s: the finished item lost its verdict: %+v", c.child, item)
			case !finished && (item.Valid || verdictError(item) != "Not checked: the expressions took too long to check."):
				t.Errorf("%s: item %d: %+v (%s)", c.child, i, item, verdictError(item))
			}
		}
		if !reaped(pid) {
			t.Errorf("%s: child %d wasn't reaped", c.child, pid)
		}
		if ts.validations.inUse() != 0 {
			t.Errorf("%s: the slot wasn't freed", c.child)
		}
	}
}

func TestLintsChildThatCrashesIsAnInternalError(t *testing.T) {
	ts := newTestServer(t, withChild(crashChild))
	if rec := ts.post(lintPath, lintBody("log", "conditions", "true")); rec.Code != 500 || errorCode(t, rec) != codeInternalError {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(ts.logs.String(), `"subcommand":"lint-child"`) {
		t.Fatalf("the failure isn't logged by its subcommand:\n%s", ts.logs.String())
	}
}

func TestLintsBodyCap(t *testing.T) {
	if DefaultMaxLintBodyBytes != 10<<20 || DefaultLintHardDeadline.Seconds() != 10 {
		t.Fatalf("the defaults: %d bytes, %v", DefaultMaxLintBodyBytes, DefaultLintHardDeadline)
	}
	ts := newTestServer(t, withSettings(func(s *Settings) { s.MaxLintBodyBytes = 1024 }))
	if rec := ts.post(lintPath, lintBody("log", "conditions", strings.Repeat("x", 1100))); rec.Code != 413 || errorCode(t, rec) != codePayloadTooLarge {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	// 200 texts of 8,192 characters escaped six bytes each fit the default.
	big := newTestServer(t)
	texts := make([]string, 200)
	for i := range texts {
		texts[i] = strings.Repeat("\x01", 8192)
	}
	reply := decodeLintReply(t, big.post(lintPath, lintBody("log", "conditions", texts...)))
	if len(reply.Items) != 200 {
		t.Fatalf("%d items", len(reply.Items))
	}
}
