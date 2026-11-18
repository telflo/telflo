// The evaluator's HTTP server (D15a spec decisions 2, 3, 10 and 11; plan
// Preflight rulings 5 and 8-12):
//
//   - One wrapper, before the mux, checks `Authorization: Bearer <secret>`
//     against the secrets' SHA-256 digests (secrets.go) on every path but
//     GET /health, so an unknown path without the secret is 401, not 404,
//     and a 401 reads no body (Connection: close).
//   - The evaluate and validate contracts (openapi.yaml): all five kinds of
//     rule, the output and the log; a rule's content problem is that rule's
//     error, never the request's.
//   - Each request's work runs in a child process killed at its limit
//     (child.go), under an in-flight cap taken before the body is read.
//   - Errors are {"error": {"code", "message"}}, never quoting the request;
//     logs carry the method, the route's pattern, the status and the
//     duration only, never the path.
//   - A path that isn't its cleaned form is 404 not_found after the secret's
//     check, never the mux's redirect (the controller's Ruling 33).
//   - D25 Task 3 (D25 spec decision 33; plan Preflight ruling 13): POST
//     /ottl/v1/lint, the public API's OTTL lint, in a child (lint-child)
//     sharing the validations' slots.

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"runtime/debug"
	"strings"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

const ottlModulePath = "github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl"

// OTTLVersion reports the pkg/ottl module version compiled into the binary
// ("unknown" in a test binary, which carries no dependencies).
func OTTLVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dep := range info.Deps {
		if dep.Path == ottlModulePath {
			return dep.Version
		}
	}
	return "unknown"
}

// The routes.
const (
	healthPath   = "/health"
	evaluatePath = "/ottl/v1/evaluate"
	validatePath = "/ottl/v1/validate"
	lintPath     = "/ottl/v1/lint"
)

// Options are what tests change; Serve passes none.
type Options struct {
	// Clock is the logs' clock (time.Now).
	Clock func() time.Time
	// ChildCommand is the binary children run, and any arguments before
	// the subcommand (this executable).
	ChildCommand []string
	// AfterFunc runs f after d unless stopped (time.AfterFunc): the slot
	// waits and the children's limits.
	AfterFunc func(d time.Duration, f func()) (stop func() bool)
	// ChildStarted is told each child's subcommand and pid.
	ChildStarted func(subcommand string, pid int)
}

// Server answers the evaluator's API.
type Server struct {
	settings    Settings
	secrets     *Secrets
	logger      *slog.Logger
	clock       func() time.Time
	afterFunc   func(time.Duration, func()) func() bool
	children    childRunner
	evaluations *slots
	validations *slots
	mux         *http.ServeMux
	patterns    []string
	// base ends when the server stops: every child still running is then
	// killed.
	base context.Context
}

// New builds a server. base bounds every child's life.
func New(base context.Context, settings Settings, secrets *Secrets, logger *slog.Logger, opts Options) (*Server, error) {
	if secrets == nil {
		return nil, errors.New("the server needs its secrets")
	}
	if opts.Clock == nil {
		opts.Clock = time.Now
	}
	if opts.AfterFunc == nil {
		opts.AfterFunc = func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }
	}
	if len(opts.ChildCommand) == 0 {
		self, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("finding this executable for the child processes: %w", err)
		}
		opts.ChildCommand = []string{self}
	}
	s := &Server{
		settings:    settings,
		secrets:     secrets,
		logger:      logger,
		clock:       opts.Clock,
		afterFunc:   opts.AfterFunc,
		children:    childRunner{command: opts.ChildCommand, afterFunc: opts.AfterFunc, started: opts.ChildStarted},
		evaluations: newSlots(settings.MaxEvaluations),
		validations: newSlots(settings.MaxValidations),
		mux:         http.NewServeMux(),
		base:        base,
	}
	s.handle("GET "+healthPath, http.HandlerFunc(s.health))
	s.handle("POST "+evaluatePath, http.HandlerFunc(s.evaluate))
	s.handle("POST "+validatePath, http.HandlerFunc(s.validate))
	s.handle("POST "+lintPath, http.HandlerFunc(s.lint))
	// Every other method on a known path, and every unknown path: the
	// envelope, not the mux's plain text.
	for _, path := range []string{healthPath, evaluatePath, validatePath, lintPath} {
		s.handle(path, http.HandlerFunc(methodNotAllowed))
	}
	s.handle("/", http.HandlerFunc(notFound))
	return s, nil
}

func (s *Server) handle(pattern string, h http.Handler) {
	s.patterns = append(s.patterns, pattern)
	s.mux.Handle(pattern, h)
}

// routes lists every pattern the mux serves.
func (s *Server) routes() []string {
	return append([]string(nil), s.patterns...)
}

// Handler is the whole server: the log line, then the panic guard, then
// the secret, then the path's form, then the routes. The secret is checked
// before anything routes or reads the body.
func (s *Server) Handler() http.Handler {
	return s.observe(s.recoverPanics(s.authenticate(requireCleanPath(s.mux))))
}

// requireCleanPath answers 404 not_found for a path that isn't its own
// cleaned form (`//health`, `/x/../health`, `/ottl/v1//evaluate`, a
// trailing slash), and for one that doesn't start with "/" (`OPTIONS *`),
// where the mux would answer a redirect in plain text (the controller's
// Ruling 33). It runs after the secret's check.
func requireCleanPath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isCleanPath(r.URL.Path) {
			notFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isCleanPath says whether p starts with "/" and is its own cleaned form.
func isCleanPath(p string) bool {
	return strings.HasPrefix(p, "/") && path.Clean(p) == p
}

// --- errors -----------------------------------------------------------------

// The error codes (Preflight ruling 9).
const (
	codeUnauthorized     = "unauthorized"
	codeNotFound         = "not_found"
	codeMethodNotAllowed = "method_not_allowed"
	codePayloadTooLarge  = "payload_too_large"
	codeInvalidRequest   = "invalid_request"
	codeEvaluatorBusy    = "evaluator_busy"
	codeInternalError    = "internal_error"
)

const (
	messageUnauthorized     = "A valid secret is required."
	messageNotFound         = "There is nothing at this path."
	messageMethodNotAllowed = "This path doesn't take that method."
	messagePayloadTooLarge  = "The request body is too large."
	messageNotJSON          = "The request's Content-Type must be application/json."
	messageUnreadableBody   = "The request body couldn't be read."
	messageEvaluatorBusy    = "The evaluator is busy. Try again shortly."
	messageInternalError    = "The evaluator couldn't answer."
)

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	Error envelopeError `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		status = http.StatusInternalServerError
		b.Reset()
		_ = json.NewEncoder(&b).Encode(envelope{Error: envelopeError{Code: codeInternalError, Message: messageInternalError}})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b.Bytes())
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, envelope{Error: envelopeError{Code: code, Message: message}})
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	// The body isn't read: close the connection rather than drain it.
	w.Header().Set("Connection", "close")
	writeError(w, http.StatusUnauthorized, codeUnauthorized, messageUnauthorized)
}

func writeBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeError(w, http.StatusServiceUnavailable, codeEvaluatorBusy, messageEvaluatorBusy)
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, codeNotFound, messageNotFound)
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	allow := http.MethodPost
	if r.URL.Path == healthPath {
		allow = "GET, HEAD"
	}
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, messageMethodNotAllowed)
}

// --- the wrappers -------------------------------------------------------------

// bearerScheme is the Authorization scheme, matched without regard to case
// (RFC 9110 section 11.1).
const bearerScheme = "Bearer"

// authenticate lets a request through only with `Authorization: Bearer
// <secret>` naming an accepted secret, on every path but GET /health. It
// reads nothing but that header; a refusal reads no body.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == healthPath {
			next.ServeHTTP(w, r)
			return
		}
		token, ok := bearerToken(r.Header)
		if !ok || !s.secrets.Accepts(token) {
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bearerToken returns the token of the request's one Authorization header,
// when it uses the Bearer scheme and has a token. Two Authorization headers
// are refused rather than guessed between.
func bearerToken(header http.Header) (string, bool) {
	values := header.Values("Authorization")
	if len(values) != 1 {
		return "", false
	}
	scheme, token, found := strings.Cut(values[0], " ")
	if !found || !strings.EqualFold(scheme, bearerScheme) {
		return "", false
	}
	token = strings.TrimLeft(token, " ")
	if token == "" {
		return "", false
	}
	return token, true
}

// recoverPanics answers a handler's panic with 500 internal_error. The log
// line names the route and the panic value's type, never the value.
func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			s.logger.Error("a handler panicked", "route", s.routePattern(r), "panic", fmt.Sprintf("%T", recovered))
			if recorder, ok := w.(*statusRecorder); ok && recorder.wroteHeader {
				panic(http.ErrAbortHandler)
			}
			writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		}()
		next.ServeHTTP(w, r)
	})
}

// observe logs each request: its method, its route's pattern, its status and
// its duration. Never a header, a body, the path or the query, a rule's
// text, a message or a snippet. GET /health, exactly, logs nothing: the
// kubelet's probes and the API's health monitor call it every few seconds
// (D33-1 decision 18, Ruling 335); every other request logs as before.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == healthPath {
			next.ServeHTTP(w, r)
			return
		}
		start := s.clock()
		method := methodName(r.Method)
		route := s.routePattern(r)
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		s.logger.Info("request",
			"method", method,
			"route", route,
			"status", recorder.status,
			"durationMs", float64(s.clock().Sub(start).Microseconds())/1000)
	})
}

// routePattern is the pattern the mux would route r to: "unmatched" for a
// path requireCleanPath refuses (the mux would name the pattern its redirect
// leads to).
func (s *Server) routePattern(r *http.Request) string {
	if !isCleanPath(r.URL.Path) {
		return "unmatched"
	}
	_, pattern := s.mux.Handler(r)
	if pattern == "" || pattern == "/" {
		return "unmatched"
	}
	return pattern
}

// methodName is a standard method, else "_OTHER", so a client's made-up
// method never reaches a log line.
func methodName(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace:
		return method
	}
	return "_OTHER"
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if !r.wroteHeader {
		r.status = status
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	r.wroteHeader = true
	return r.ResponseWriter.Write(p)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// --- the routes ---------------------------------------------------------------

type healthAnswer struct {
	Status      string `json:"status"`
	OTTLVersion string `json:"ottlVersion"`
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthAnswer{Status: "ok", OTTLVersion: OTTLVersion()})
}

// admit runs the steps every POST shares, in order: a declared length past
// the cap (413, nothing read), the content type (400), a slot (503 past the
// wait, before the body is read), then the body, read up to the cap (413
// past it). It returns the body and the slot's release, or false once it has
// answered.
func (s *Server) admit(w http.ResponseWriter, r *http.Request, maxBytes int64, pool *slots, wait time.Duration) ([]byte, func(), bool) {
	if r.ContentLength > maxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, codePayloadTooLarge, messagePayloadTooLarge)
		return nil, nil, false
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, messageNotJSON)
		return nil, nil, false
	}
	release, ok := pool.acquire(r.Context(), wait, s.afterFunc)
	if !ok {
		writeBusy(w)
		return nil, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err != nil {
		release()
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, codePayloadTooLarge, messagePayloadTooLarge)
		} else {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, messageUnreadableBody)
		}
		return nil, nil, false
	}
	return body, release, true
}

// requestContext ends with the request or the server.
func (s *Server) requestContext(r *http.Request) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(s.base, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

type evaluateAnswer struct {
	OTTLVersion string         `json:"ottlVersion"`
	Results     []rules.Result `json:"results"`
}

func (s *Server) evaluate(w http.ResponseWriter, r *http.Request) {
	body, release, ok := s.admit(w, r, s.settings.MaxEvaluateBodyBytes, s.evaluations, s.settings.EvaluateWait)
	if !ok {
		return
	}
	// The slot is freed only once the child is reaped.
	defer release()
	req, shapeErr := decodeEvaluate(body)
	body = nil
	if shapeErr != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, shapeErr.message)
		return
	}
	header, err := json.Marshal(rules.EvaluateHeader{
		Input: rules.Input{
			Signal: req.signal, OutputPresent: req.outputPresent, Truncated: req.truncated,
			Log: req.log, Rules: req.rules, MaxOutputObjects: s.settings.MaxOutputObjects,
		},
		OutputBytes:  len(req.output),
		SoftDeadline: s.settings.EvaluateSoftDeadline,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}
	stdin := io.MultiReader(bytes.NewReader(header), strings.NewReader("\n"), bytes.NewReader(req.output))

	ctx, cancel := s.requestContext(r)
	defer cancel()
	outcome := s.children.run(ctx, EvaluateChildCommand, stdin, s.settings.EvaluateHardDeadline, len(req.rules))

	got, ok := resultLines(outcome.lines, req.rules)
	var message string
	switch {
	case !ok:
		s.childFailed(EvaluateChildCommand, outcome)
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	case outcome.end == childExited && outcome.exitCode == rules.ExitDone && len(got) == len(req.rules):
	case outcome.end == childExited && outcome.exitCode == rules.ExitDeadline, outcome.end == childAtLimit:
		message = rules.NotCheckedDeadline
	case outcome.end == childOutOfMemory:
		message = rules.NotCheckedMemory
	case outcome.end == childStopped:
		// The request or the server ended: no one is waiting for the answer.
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	default:
		s.childFailed(EvaluateChildCommand, outcome)
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}
	writeJSON(w, http.StatusOK, evaluateAnswer{OTTLVersion: OTTLVersion(), Results: rules.Complete(req.rules, got, message)})
}

// resultLines decodes the child's lines: one result per finished rule, in
// the rules' order.
func resultLines(lines [][]byte, ruleList []rules.Rule) ([]rules.Result, bool) {
	results := make([]rules.Result, 0, len(lines))
	for i, line := range lines {
		var result rules.Result
		if i >= len(ruleList) || json.Unmarshal(line, &result) != nil || result.ID != ruleList[i].ID {
			return nil, false
		}
		results = append(results, result)
	}
	return results, true
}

// childFailed logs a child's unexplained end: its subcommand and how it
// ended, never its output.
func (s *Server) childFailed(subcommand string, outcome childOutcome) {
	s.logger.Error("a child process failed", "subcommand", subcommand, "end", int(outcome.end), "exitCode", outcome.exitCode)
}

type validateAnswer struct {
	Valid       bool             `json:"valid"`
	Problems    *[]rules.Problem `json:"problems,omitempty"`
	OTTLVersion string           `json:"ottlVersion"`
}

func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	body, release, ok := s.admit(w, r, s.settings.MaxValidateBodyBytes, s.validations, s.settings.ValidateWait)
	if !ok {
		return
	}
	defer release()
	req, shapeErr := decodeValidate(body)
	if shapeErr != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, shapeErr.message)
		return
	}
	input, err := json.Marshal(rules.ValidateInput{Signal: req.signal, Rule: req.rule})
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}

	ctx, cancel := s.requestContext(r)
	defer cancel()
	// A line per field the child checks, and its problems.
	outcome := s.children.run(ctx, ValidateChildCommand, bytes.NewReader(input), s.settings.ValidateHardDeadline, 8)

	checking := defaultField(req.rule)
	var problems *[]rules.Problem
	for _, raw := range outcome.lines {
		var line rules.ValidateLine
		if json.Unmarshal(raw, &line) != nil {
			problems = nil
			break
		}
		if line.Checking != "" {
			checking = line.Checking
		}
		if line.Problems != nil {
			problems = line.Problems
		}
	}
	switch {
	case outcome.end == childExited && outcome.exitCode == rules.ExitDone && problems != nil:
	case outcome.end == childAtLimit, outcome.end == childOutOfMemory:
		problems = &[]rules.Problem{{Field: checking, Message: rules.TooComplex(checking)}}
	case outcome.end == childStopped:
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	default:
		s.childFailed(ValidateChildCommand, outcome)
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}
	answer := validateAnswer{Valid: len(*problems) == 0, OTTLVersion: OTTLVersion()}
	if !answer.Valid {
		answer.Problems = problems
	}
	writeJSON(w, http.StatusOK, answer)
}

type lintAnswer struct {
	OTTLVersion string              `json:"ottlVersion"`
	Items       []rules.LintVerdict `json:"items"`
}

// lint answers the public API's OTTL lint (D25 Task 3): each text's
// verdict, in the order conditions, statements, value expressions, with no
// text echoed. The texts are parsed in a child (lint-child) holding one of
// the validations' slots, killed at LintHardDeadline; the items it hadn't
// reached are "Not checked".
func (s *Server) lint(w http.ResponseWriter, r *http.Request) {
	body, release, ok := s.admit(w, r, s.settings.MaxLintBodyBytes, s.validations, s.settings.ValidateWait)
	if !ok {
		return
	}
	defer release()
	input, shapeErr := decodeLint(body)
	body = nil
	if shapeErr != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, shapeErr.message)
		return
	}
	stdin, err := json.Marshal(input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}
	targets := input.Targets()

	ctx, cancel := s.requestContext(r)
	defer cancel()
	outcome := s.children.run(ctx, LintChildCommand, bytes.NewReader(stdin), s.settings.LintHardDeadline, len(targets))

	got, ok := lintLines(outcome.lines, targets)
	var message string
	switch {
	case !ok:
		s.childFailed(LintChildCommand, outcome)
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	case outcome.end == childExited && outcome.exitCode == rules.ExitDone && len(got) == len(targets):
	case outcome.end == childAtLimit:
		message = rules.NotCheckedLint
	case outcome.end == childOutOfMemory:
		message = rules.NotCheckedLintMemory
	case outcome.end == childStopped:
		// The request or the server ended: no one is waiting for the answer.
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	default:
		s.childFailed(LintChildCommand, outcome)
		writeError(w, http.StatusInternalServerError, codeInternalError, messageInternalError)
		return
	}
	items := make([]rules.LintVerdict, len(targets))
	for i, target := range targets {
		if i < len(got) {
			items[i] = got[i]
		} else {
			items[i] = rules.NotCheckedVerdict(target, message)
		}
	}
	writeJSON(w, http.StatusOK, lintAnswer{OTTLVersion: OTTLVersion(), Items: items})
}

// lintLines decodes the lint child's lines: one verdict per finished text,
// in the targets' order, each naming its own kind and index.
func lintLines(lines [][]byte, targets []rules.LintTarget) ([]rules.LintVerdict, bool) {
	verdicts := make([]rules.LintVerdict, 0, len(lines))
	for i, line := range lines {
		var verdict rules.LintVerdict
		if i >= len(targets) || json.Unmarshal(line, &verdict) != nil ||
			verdict.Kind != targets[i].Kind || verdict.Index != targets[i].Index || verdict.Valid != (verdict.Error == nil) {
			return nil, false
		}
		verdicts = append(verdicts, verdict)
	}
	return verdicts, true
}

// defaultField is the field a check killed before it named one is about.
func defaultField(rule rules.Rule) string {
	if rule.OTTL == nil {
		return rules.FieldPattern
	}
	if rule.OTTL.Condition != nil {
		return rules.FieldCondition
	}
	return rules.FieldExpression
}
