// The server tests' harness. The server runs its children from its own
// executable, which in a test is the test binary, so TestMain answers the
// child subcommands before the tests run: the real ones, and a few
// stand-ins for a child that never ends, one the kernel kills for memory,
// one the Go runtime kills, and one that crashes, plus lint-child and a
// lint that finishes one text, then hangs.

package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

// The stand-in children, named before the subcommand on the command line.
const (
	hangChild         = "test-hang"           // reads its input, then never ends
	hangCheckingChild = "test-hang-checking"  // validate: names a field, then never ends
	memoryKillChild   = "test-sigkill-after1" // evaluate: finishes one rule, then SIGKILLs itself
	runtimeOOMChild   = "test-runtime-oom"    // dies as the Go runtime does out of memory
	crashChild        = "test-crash"          // exits 7
	// Stand-ins for the child's environment, group and reap:
	reportChild    = "test-report"     // reports its environment and group to a FIFO, starts a grandchild, never ends
	serveDiesChild = "test-serve-dies" // plays serve: starts a hanging child, prints its pid, then exits at once
	// A stand-in for the lint:
	lintOneThenHangChild = "test-lint-one-then-hang" // lint: answers its first text valid, says so on a FIFO, then never ends
)

func TestMain(m *testing.M) {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case EvaluateChildCommand:
			os.Exit(rules.RunEvaluateChild(os.Stdin, os.Stdout, time.Now))
		case ValidateChildCommand:
			os.Exit(rules.RunValidateChild(os.Stdin, os.Stdout))
		case LintChildCommand:
			os.Exit(rules.RunLintChild(os.Stdin, os.Stdout))
		case lintOneThenHangChild:
			// os.Args: lintOneThenHangChild, the FIFO's path, the subcommand.
			var input rules.LintInput
			_ = json.NewDecoder(os.Stdin).Decode(&input)
			first := input.Targets()[0]
			line, _ := json.Marshal(rules.LintVerdict{Kind: first.Kind, Index: first.Index, Valid: true})
			_, _ = os.Stdout.Write(append(line, '\n'))
			if fifo, err := os.OpenFile(os.Args[2], os.O_WRONLY, 0); err == nil {
				_, _ = fifo.WriteString("written\n")
				_ = fifo.Close()
			}
			hang()
		case hangChild:
			_, _ = io.Copy(io.Discard, os.Stdin)
			hang()
		case hangCheckingChild:
			_, _ = io.Copy(io.Discard, os.Stdin)
			_, _ = os.Stdout.WriteString(`{"checking":"ottl.expression"}` + "\n")
			hang()
		case memoryKillChild:
			in := bufio.NewReader(os.Stdin)
			line, _ := in.ReadBytes('\n')
			var header rules.EvaluateHeader
			_ = json.Unmarshal(line, &header)
			result, _ := json.Marshal(rules.Result{ID: header.Rules[0].ID, Passed: true})
			_, _ = os.Stdout.Write(append(result, '\n'))
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			hang()
		case runtimeOOMChild:
			_, _ = io.Copy(io.Discard, os.Stdin)
			_, _ = os.Stderr.WriteString("fatal error: runtime: out of memory\n")
			os.Exit(2)
		case crashChild:
			_, _ = io.Copy(io.Discard, os.Stdin)
			os.Exit(7)
		case reportChild:
			// os.Args: reportChild, the FIFO's path, the subcommand.
			_, _ = io.Copy(io.Discard, os.Stdin)
			reportToFIFO(os.Args[2])
			hang()
		case serveDiesChild:
			serveThenDie()
		}
	}
	os.Exit(m.Run())
}

// hang stands in for work that never ends: the test kills it (through its
// injected timer), never waits for it.
func hang() {
	for {
		time.Sleep(time.Hour)
	}
}

const (
	testSecret     = "test-only-ottl-evaluator-secret-0123456789"
	previousSecret = "test-only-previous-ottl-evaluator-secret-9876"
)

// hangGuard is the only wall-clock limit the tests use: how long a test
// waits for something that should already have happened.
const hangGuard = 60 * time.Second

// timers is a fake AfterFunc: nothing fires unless a test fires it.
type timers struct {
	added chan *timer
}

type timer struct {
	d       time.Duration
	f       func()
	mu      sync.Mutex
	stopped bool
}

func newTimers() *timers {
	return &timers{added: make(chan *timer, 256)}
}

// afterFunc never blocks: past the buffer (a test that sets many timers and
// reads none), a new timer is dropped unread, never the test's run.
func (ts *timers) afterFunc(d time.Duration, f func()) func() bool {
	t := &timer{d: d, f: f}
	select {
	case ts.added <- t:
	default:
	}
	return func() bool {
		t.mu.Lock()
		defer t.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

// next waits for the next timer of duration d (others are skipped).
func (ts *timers) next(t *testing.T, d time.Duration) *timer {
	t.Helper()
	deadline := time.After(hangGuard)
	for {
		select {
		case tm := <-ts.added:
			if tm.d == d {
				return tm
			}
		case <-deadline:
			t.Fatalf("no %v timer was set", d)
		}
	}
}

func (tm *timer) fire() {
	tm.mu.Lock()
	stopped := tm.stopped
	tm.mu.Unlock()
	if !stopped {
		tm.f()
	}
}

// testServer is a server with fake timers, its log captured.
type testServer struct {
	*Server
	handler  http.Handler
	timers   *timers
	logs     *syncBuffer
	started  chan int
	settings Settings
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type serverOption func(*Settings, *Options)

func withChild(stand string) serverOption {
	return func(_ *Settings, o *Options) {
		self, _ := os.Executable()
		o.ChildCommand = []string{self, stand}
	}
}

func withSettings(change func(*Settings)) serverOption {
	return func(s *Settings, _ *Options) { change(s) }
}

func newTestServer(t *testing.T, options ...serverOption) *testServer {
	t.Helper()
	secrets, err := NewSecrets(testSecret, []string{previousSecret})
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{timers: newTimers(), logs: &syncBuffer{}, started: make(chan int, 256), settings: DefaultSettings()}
	opts := Options{
		AfterFunc: ts.timers.afterFunc,
		ChildStarted: func(_ string, pid int) {
			// Never blocks a request, as afterFunc.
			select {
			case ts.started <- pid:
			default:
			}
		},
	}
	for _, option := range options {
		option(&ts.settings, &opts)
	}
	base, cancel := contextWithCancel()
	t.Cleanup(cancel)
	s, err := New(base, ts.settings, secrets, slog.New(slog.NewJSONHandler(ts.logs, nil)), opts)
	if err != nil {
		t.Fatal(err)
	}
	ts.Server, ts.handler = s, s.Handler()
	return ts
}

// call sends a request through the whole handler.
func (ts *testServer) call(method, target, body, token string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	return rec
}

func (ts *testServer) post(target, body string) *httptest.ResponseRecorder {
	return ts.call(http.MethodPost, target, body, testSecret)
}

// pid waits for the next child to start.
func (ts *testServer) pid(t *testing.T) int {
	t.Helper()
	select {
	case pid := <-ts.started:
		return pid
	case <-time.After(hangGuard):
		t.Fatal("no child started")
		return 0
	}
}

// reaped says whether pid is gone (waited for, not a zombie).
func reaped(pid int) bool {
	return syscall.Kill(pid, 0) == syscall.ESRCH
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("not the envelope: %s", rec.Body.String())
	}
	return e.Error.Code
}

type answer struct {
	OTTLVersion string         `json:"ottlVersion"`
	Results     []rules.Result `json:"results"`
}

func decodeAnswer(t *testing.T, rec *httptest.ResponseRecorder) answer {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var a answer
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
		t.Fatalf("answer: %v", err)
	}
	return a
}

func resultError(r rules.Result) string {
	if r.Error == nil {
		return ""
	}
	return *r.Error
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// evaluateBody builds an evaluate request: output nil is null.
func evaluateBody(signal string, output *string, log string, ruleList ...string) string {
	out := "null"
	if output != nil {
		out = `{"base64":` + jsonQuote(b64(*output)) + `,"truncated":false}`
	}
	return `{"signal":"` + signal + `","output":` + out + `,"log":` + jsonQuote(log) + `,"rules":[` + strings.Join(ruleList, ",") + `]}`
}

func textRuleJSON(id, kind, target, pattern string) string {
	return `{"id":"` + id + `","kind":"` + kind + `","target":"` + target + `","pattern":` + jsonQuote(pattern) + `}`
}

func ottlRuleJSON(id, context, quantifier, condition string) string {
	return `{"id":"` + id + `","kind":"ottl","target":"output","ottl":{"context":"` + context + `","quantifier":"` + quantifier + `","condition":` + jsonQuote(condition) + `}}`
}

func strPtr(s string) *string { return &s }
