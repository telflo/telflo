// New in D15a Task 2 (plan Task 2; docs/conventions/go.md, "Code shape"),
// after the opamp-server's management/conformance_test.go: openapi.yaml
// is what the platform's client and its fake are written against, so every
// documented answer is produced here by the real handler (real children
// included), and each request and each reply is validated against the file
// with kin-openapi. Both ways: a request the file refuses must be one the
// server refuses (and kin-openapi must refuse it too: the rule is
// documented), a route the server registers must be in the file, and an
// operation in the file must be registered.
//
// D25 Task 3 added the lint's answers (POST /ottl/v1/lint).
//
// kin-openapi v0.149.0 is a test-only dependency (the controller's Ruling
// 30): no file outside a _test.go imports it, so it is never in the binary
// the license check scans.

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

const (
	specPath   = "../../openapi.yaml"
	specServer = "http://localhost:8003"
	jsonType   = "application/json"
)

// catchAlls are the patterns that are no route of their own: they answer
// 404 for an unknown path and 405 for another method on a known one.
var catchAlls = []string{"/", healthPath, evaluatePath, validatePath, lintPath}

func loadSpec(t *testing.T) *openapi3.T {
	t.Helper()
	doc, err := openapi3.NewLoader().LoadFromFile(specPath)
	if err != nil {
		t.Fatalf("loading %s: %v", specPath, err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("%s isn't a valid OpenAPI document: %v", specPath, err)
	}
	if !doc.IsOpenAPI31OrLater() {
		t.Fatalf("%s is OpenAPI %s, want 3.1", specPath, doc.OpenAPI)
	}
	inlineSchemaRefs(doc)
	inlined, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(inlined), "#/components/schemas/") {
		t.Fatal("a schema reference survived inlineSchemaRefs: kin-openapi would validate it with its fallback validator")
	}
	return doc
}

// inlineSchemaRefs clears every schema's $ref, keeping the schema the loader
// resolved it to: kin-openapi validates 3.1 schemas with a JSON Schema
// 2020-12 validator that compiles each schema on its own, where a
// "#/components/…" reference can't resolve, and would then silently fall
// back to its older validator.
func inlineSchemaRefs(doc *openapi3.T) {
	seen := map[*openapi3.Schema]bool{}
	var walk func(ref *openapi3.SchemaRef)
	walk = func(ref *openapi3.SchemaRef) {
		if ref == nil {
			return
		}
		ref.Ref = ""
		schema := ref.Value
		if schema == nil || seen[schema] {
			return
		}
		seen[schema] = true
		for _, property := range schema.Properties {
			walk(property)
		}
		walk(schema.Items)
		walk(schema.Not)
		walk(schema.AdditionalProperties.Schema)
		for _, list := range []openapi3.SchemaRefs{schema.AllOf, schema.AnyOf, schema.OneOf} {
			for _, item := range list {
				walk(item)
			}
		}
	}
	walkContent := func(content openapi3.Content) {
		for _, media := range content {
			walk(media.Schema)
		}
	}
	for _, schema := range doc.Components.Schemas {
		walk(schema)
	}
	for _, response := range doc.Components.Responses {
		walkContent(response.Value.Content)
		for _, header := range response.Value.Headers {
			walk(header.Value.Schema)
		}
	}
	for _, item := range doc.Paths.Map() {
		for _, operation := range item.Operations() {
			if operation.RequestBody != nil && operation.RequestBody.Value != nil {
				walkContent(operation.RequestBody.Value.Content)
			}
			for _, response := range operation.Responses.Map() {
				if response.Value == nil {
					continue
				}
				walkContent(response.Value.Content)
				for _, header := range response.Value.Headers {
					walk(header.Value.Schema)
				}
			}
		}
	}
}

// validationOptions check the documented bearer scheme: a request passes
// only with "Bearer <something>" (whether it is the secret is the server's
// business).
func validationOptions() *openapi3filter.Options {
	return &openapi3filter.Options{
		IncludeResponseStatus: true,
		AuthenticationFunc: func(_ context.Context, input *openapi3filter.AuthenticationInput) error {
			scheme := input.SecurityScheme
			if scheme == nil || scheme.Type != "http" || !strings.EqualFold(scheme.Scheme, "bearer") {
				return fmt.Errorf("an undocumented security scheme")
			}
			if _, ok := bearerToken(input.RequestValidationInput.Request.Header); !ok {
				return fmt.Errorf("no bearer token")
			}
			return nil
		},
	}
}

func documentedAnswers(doc *openapi3.T) []string {
	var answers []string
	for path, item := range doc.Paths.Map() {
		for method, operation := range item.Operations() {
			for status := range operation.Responses.Map() {
				answers = append(answers, method+" "+path+" "+status)
			}
		}
	}
	slices.Sort(answers)
	return answers
}

func undocumentedRoutes(doc *openapi3.T, routes []string) []string {
	var undocumented []string
	for _, pattern := range routes {
		if slices.Contains(catchAlls, pattern) {
			continue
		}
		method, path, found := strings.Cut(pattern, " ")
		if !found {
			undocumented = append(undocumented, "every method "+pattern)
			continue
		}
		item := doc.Paths.Value(path)
		if item == nil || item.GetOperation(method) == nil {
			undocumented = append(undocumented, pattern)
		}
	}
	return undocumented
}

func unregisteredOperations(doc *openapi3.T, routes []string) []string {
	var missing []string
	for path, item := range doc.Paths.Map() {
		for method := range item.Operations() {
			if !slices.Contains(routes, method+" "+path) {
				missing = append(missing, method+" "+path)
			}
		}
	}
	return missing
}

// conformanceCase is one request and the documented answer it must get.
type conformanceCase struct {
	name, method, target, contentType, body string
	unauthenticated                         bool
	// server builds the server the request goes to (default: a plain one).
	server func(t *testing.T) *testServer
	status int
	// conforms says whether the request follows the file. One that doesn't
	// must be refused by kin-openapi too: the rule it breaks is documented.
	conforms bool
}

func (c conformanceCase) newRequest() *http.Request {
	var body io.Reader
	if c.body != "" {
		body = strings.NewReader(c.body)
	}
	req := httptest.NewRequest(c.method, specServer+c.target, body)
	if c.contentType != "" {
		req.Header.Set("Content-Type", c.contentType)
	}
	if !c.unauthenticated {
		req.Header.Set("Authorization", "Bearer "+testSecret)
	}
	return req
}

// busyServer is a server whose only slot of each kind is taken, and which
// waits for none.
func busyServer(t *testing.T) *testServer {
	ts := newTestServer(t, withSettings(func(s *Settings) {
		s.MaxEvaluations, s.MaxValidations = 1, 1
		s.EvaluateWait, s.ValidateWait = 0, 0
	}))
	for _, pool := range []*slots{ts.evaluations, ts.validations} {
		release, ok := pool.acquire(context.Background(), 0, nil)
		if !ok {
			t.Fatal("no slot")
		}
		t.Cleanup(release)
	}
	return ts
}

func smallBodyServer(t *testing.T) *testServer {
	return newTestServer(t, withSettings(func(s *Settings) {
		s.MaxEvaluateBodyBytes, s.MaxValidateBodyBytes, s.MaxLintBodyBytes = 1024, 512, 512
	}))
}

func crashingServer(t *testing.T) *testServer {
	return newTestServer(t, withChild(crashChild))
}

func conformanceCases() []conformanceCase {
	output := `{"records":[` + logsPayload + `,` + logsPayload + `]}`
	evaluate := func(rules ...string) string { return evaluateBody("logs", &output, "INFO x\nWARN dropped\n", rules...) }
	everyDetail := evaluate(
		textRuleJSON("a", "contains_text", "output", `"stringValue": "hello"`),
		textRuleJSON("b", "contains_text", "output", "nowhere"),
		textRuleJSON("c", "not_contains_text", "output", "hello"),
		textRuleJSON("d", "not_contains_regex", "stderr", `WARN \w+`),
		textRuleJSON("e", "not_contains_regex", "output", `z*`), // failed, no detail, an advisory
		ottlRuleJSON("f", "log", "all", `body == "nope"`),
		ottlRuleJSON("g", "scope", "none", `name == "nope"`),
		`{"id":"h","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"distinct","expression":"body","count":{"operator":"eq","value":0}}}`,
		`{"id":"i","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"between","value":1,"value2":2}}}`,
		textRuleJSON("j", "contains_regex", "output", "(unclosed"),
		ottlRuleJSON("k", "span", "all", "true"),
	)
	null := evaluateBody("logs", nil, "", ottlRuleJSON("a", "log", "all", "true"), textRuleJSON("b", "contains_text", "output", "x"))
	truncated := strings.Replace(evaluate(textRuleJSON("a", "contains_text", "output", "hello")), `"truncated":false`, `"truncated":true`, 1)
	validate := func(rule string) string { return `{"signal":"logs","rule":` + rule + `}` }
	validRegex := validate(`{"kind":"contains_regex","target":"output","pattern":"\\d+"}`)
	brokenOTTL := validate(`{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"attributes["}}`)
	inconsistent := validate(`{"kind":"ottl","target":"output","ottl":{"context":"span","quantifier":"count","condition":" ","count":{"operator":"between","value":5,"value2":4}}}`)
	textRule := textRuleJSON("a", "contains_text", "output", "x")
	tooLong := strings.Repeat("x", 8193)
	lintEvery := `{"context":"log","conditions":["severity_number >= 17","attributes["],` +
		`"statements":["set(attributes[\"env\"], \"prod\")"],"valueExpressions":["body",""]}`
	lintMany := `{"context":"span","conditions":[` + strings.TrimSuffix(strings.Repeat(`"true",`, 150), ",") +
		`],"statements":[` + strings.TrimSuffix(strings.Repeat(`"set(name, \"x\")",`, 51), ",") + `]}`
	return []conformanceCase{
		{name: "health", method: http.MethodGet, target: healthPath, unauthenticated: true, status: 200, conforms: true},

		{name: "evaluate every detail", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: everyDetail, status: 200, conforms: true},
		{name: "evaluate a null output", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: null, status: 200, conforms: true},
		{name: "evaluate a truncated output", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: truncated, status: 200, conforms: true},
		{name: "evaluate a count as 2.0", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 200, conforms: true,
			body: evaluate(`{"id":"a","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":2.0}}}`)},
		{name: "evaluate past the deadline", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: everyDetail, status: 200, conforms: true,
			server: func(t *testing.T) *testServer {
				return newTestServer(t, withSettings(func(s *Settings) { s.EvaluateSoftDeadline = 0 }))
			}},
		{name: "evaluate a repeated id", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: evaluate(textRule, textRule), status: 400, conforms: true},
		{name: "evaluate base64 that doesn't decode", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: true,
			body: `{"signal":"logs","output":{"base64":"!!!!","truncated":false},"log":"","rules":[` + textRule + `]}`},
		{name: "evaluate a retired kind", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: evaluate(textRuleJSON("a", "record_count", "output", "x"))},
		{name: "evaluate an OTTL rule on the log", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: evaluate(`{"id":"a","kind":"ottl","target":"stderr","ottl":{"context":"log","quantifier":"all","condition":"true"}}`)},
		{name: "evaluate a pattern over 8,192 characters", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: evaluate(textRuleJSON("a", "contains_text", "output", tooLong))},
		{name: "evaluate an unknown member", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: evaluate(`{"id":"a","kind":"contains_text","target":"output","pattern":"x","name":"n"}`)},
		{name: "evaluate a negative count", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: evaluate(`{"id":"a","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":-1}}}`)},
		{name: "evaluate no rules", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: evaluate(), status: 400, conforms: false},
		{name: "evaluate no log", method: http.MethodPost, target: evaluatePath, contentType: jsonType, status: 400, conforms: false,
			body: `{"signal":"logs","output":null,"rules":[` + textRule + `]}`},
		{name: "evaluate text/plain", method: http.MethodPost, target: evaluatePath, contentType: "text/plain", body: null, status: 400, conforms: false},
		{name: "evaluate without the secret", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: null, unauthenticated: true, status: 401, conforms: false},
		{name: "evaluate too large", method: http.MethodPost, target: evaluatePath, contentType: jsonType, server: smallBodyServer, status: 413, conforms: true,
			body: evaluateBody("logs", nil, strings.Repeat("x", 2000), textRule)},
		{name: "evaluate busy", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: null, server: busyServer, status: 503, conforms: true},
		{name: "evaluate a child that fails", method: http.MethodPost, target: evaluatePath, contentType: jsonType, body: null, server: crashingServer, status: 500, conforms: true},

		{name: "validate a valid rule", method: http.MethodPost, target: validatePath, contentType: jsonType, body: validRegex, status: 200, conforms: true},
		{name: "validate a broken condition", method: http.MethodPost, target: validatePath, contentType: jsonType, body: brokenOTTL, status: 200, conforms: true},
		{name: "validate an inconsistent rule", method: http.MethodPost, target: validatePath, contentType: jsonType, body: inconsistent, status: 200, conforms: true},
		{name: "validate a blank text", method: http.MethodPost, target: validatePath, contentType: jsonType, status: 200, conforms: true,
			body: validate(`{"kind":"not_contains_text","target":"stderr","pattern":"  "}`)},
		{name: "validate a rule with an id", method: http.MethodPost, target: validatePath, contentType: jsonType, status: 400, conforms: false,
			body: validate(`{"id":"a","kind":"contains_text","target":"output","pattern":"x"}`)},
		{name: "validate an unknown signal", method: http.MethodPost, target: validatePath, contentType: jsonType, status: 400, conforms: false,
			body: `{"signal":"profiles","rule":{"kind":"contains_text","target":"output","pattern":"x"}}`},
		{name: "validate a count as a string", method: http.MethodPost, target: validatePath, contentType: jsonType, status: 400, conforms: false,
			body: validate(`{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":"2"}}}`)},
		{name: "validate without the secret", method: http.MethodPost, target: validatePath, contentType: jsonType, body: validRegex, unauthenticated: true, status: 401, conforms: false},
		{name: "validate too large", method: http.MethodPost, target: validatePath, contentType: jsonType, server: smallBodyServer, status: 413, conforms: true,
			body: validate(`{"kind":"contains_text","target":"output","pattern":"` + strings.Repeat("x", 600) + `"}`)},
		{name: "validate busy", method: http.MethodPost, target: validatePath, contentType: jsonType, body: validRegex, server: busyServer, status: 503, conforms: true},
		{name: "validate a child that fails", method: http.MethodPost, target: validatePath, contentType: jsonType, body: validRegex, server: crashingServer, status: 500, conforms: true},

		{name: "lint every kind, valid and not", method: http.MethodPost, target: lintPath, contentType: jsonType, body: lintEvery, status: 200, conforms: true},
		{name: "lint 200 texts", method: http.MethodPost, target: lintPath, contentType: jsonType, status: 200, conforms: true,
			body: `{"context":"metric","conditions":[` + strings.TrimSuffix(strings.Repeat(`"name == \"up\"",`, 200), ",") + `]}`},
		{name: "lint more than 200 texts in all", method: http.MethodPost, target: lintPath, contentType: jsonType, body: lintMany, status: 400, conforms: true},
		{name: "lint no text", method: http.MethodPost, target: lintPath, contentType: jsonType, body: `{"context":"log","conditions":[]}`, status: 400, conforms: false},
		{name: "lint an unknown context", method: http.MethodPost, target: lintPath, contentType: jsonType, body: `{"context":"trace","conditions":["true"]}`, status: 400, conforms: false},
		{name: "lint a text over 8,192 characters", method: http.MethodPost, target: lintPath, contentType: jsonType, status: 400, conforms: false,
			body: `{"context":"log","conditions":[` + jsonQuote(tooLong) + `]}`},
		{name: "lint an unknown member", method: http.MethodPost, target: lintPath, contentType: jsonType, status: 400, conforms: false,
			body: `{"context":"log","conditions":["true"],"yaml":"x"}`},
		{name: "lint without the secret", method: http.MethodPost, target: lintPath, contentType: jsonType, body: lintEvery, unauthenticated: true, status: 401, conforms: false},
		{name: "lint too large", method: http.MethodPost, target: lintPath, contentType: jsonType, server: smallBodyServer, status: 413, conforms: true,
			body: `{"context":"log","conditions":[` + jsonQuote(strings.Repeat("x", 600)) + `]}`},
		{name: "lint busy", method: http.MethodPost, target: lintPath, contentType: jsonType, body: lintEvery, server: busyServer, status: 503, conforms: true},
		{name: "lint a child that fails", method: http.MethodPost, target: lintPath, contentType: jsonType, body: lintEvery, server: crashingServer, status: 500, conforms: true},
	}
}

// validateExchange validates one request against the file (expecting it to
// conform or not), sends it through the real handler, and validates the
// reply. It returns the documented path the request matched.
func validateExchange(t *testing.T, router routers.Router, c conformanceCase) string {
	t.Helper()
	ctx := context.Background()
	options := validationOptions()
	route, pathParams, err := router.FindRoute(c.newRequest())
	if err != nil {
		t.Fatalf("%s: the file has no operation for %s %s: %v", c.name, c.method, c.target, err)
	}
	requestInput := &openapi3filter.RequestValidationInput{Request: c.newRequest(), PathParams: pathParams, Route: route, Options: options}
	requestErr := openapi3filter.ValidateRequest(ctx, requestInput)
	switch {
	case c.conforms && requestErr != nil:
		t.Fatalf("%s: the request doesn't follow the file: %v", c.name, requestErr)
	case !c.conforms && requestErr == nil:
		t.Fatalf("%s: the request breaks a rule the file doesn't state (kin-openapi accepted it)", c.name)
	}

	build := c.server
	if build == nil {
		build = func(t *testing.T) *testServer { return newTestServer(t) }
	}
	ts := build(t)
	recorder := httptest.NewRecorder()
	ts.handler.ServeHTTP(recorder, c.newRequest())
	if recorder.Code != c.status {
		t.Fatalf("%s: %d %s, want %d", c.name, recorder.Code, recorder.Body.String(), c.status)
	}
	responseInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: requestInput,
		Status:                 recorder.Code,
		Header:                 recorder.Header(),
		Body:                   io.NopCloser(bytes.NewReader(recorder.Body.Bytes())),
		Options:                options,
	}
	if err := openapi3filter.ValidateResponse(ctx, responseInput); err != nil {
		t.Fatalf("%s: the reply doesn't follow the file: %v\nreply: %.800s", c.name, err, recorder.Body.String())
	}
	if err := undocumentedErrorCode(route.Operation, recorder.Code, recorder.Body.Bytes()); err != nil {
		t.Fatalf("%s: %v", c.name, err)
	}
	return route.Path
}

// undocumentedErrorCode fails when an error reply's code isn't the one its
// documented response shows in its example.
func undocumentedErrorCode(operation *openapi3.Operation, status int, body []byte) error {
	if status < 400 {
		return nil
	}
	var reply envelope
	if err := json.Unmarshal(body, &reply); err != nil {
		return fmt.Errorf("the error reply isn't the envelope: %v", err)
	}
	response := operation.Responses.Status(status)
	if response == nil || response.Value == nil {
		return fmt.Errorf("no documented response for %d", status)
	}
	media := response.Value.Content.Get(jsonType)
	if media == nil || media.Example == nil {
		return fmt.Errorf("the documented %d has no example", status)
	}
	raw, _ := json.Marshal(media.Example)
	var documented envelope
	if json.Unmarshal(raw, &documented) != nil || documented.Error.Code != reply.Error.Code {
		return fmt.Errorf("answered %d %s, but the documented response names %s", status, reply.Error.Code, documented.Error.Code)
	}
	return nil
}

func TestEveryDocumentedAnswerConformsToOpenAPI(t *testing.T) {
	doc := loadSpec(t)
	router, err := gorillamux.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	answered := map[string]bool{}
	for _, c := range conformanceCases() {
		path := validateExchange(t, router, c)
		answered[c.method+" "+path+" "+strconv.Itoa(c.status)] = true
	}
	for _, answer := range documentedAnswers(doc) {
		if !answered[answer] {
			t.Errorf("no case gets the documented answer %s", answer)
		}
	}
}

// New in D15a's final fix wave (Ruling 55): "evaluate every detail"
// answers, and the file accepts, a failed result with no error and no
// detail but an advisory (rule e's empty matches).
func TestEveryDetailIncludesAFailedResultWithOnlyAnAdvisory(t *testing.T) {
	c := conformanceCases()[1]
	if c.name != "evaluate every detail" {
		t.Fatalf("case 1 is %q", c.name)
	}
	ts := newTestServer(t)
	recorder := httptest.NewRecorder()
	ts.handler.ServeHTTP(recorder, c.newRequest())
	var answer struct {
		Results []struct {
			ID       string          `json:"id"`
			Passed   bool            `json:"passed"`
			Error    *string         `json:"error"`
			Advisory *string         `json:"advisory"`
			Detail   json.RawMessage `json:"detail"`
		} `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil || len(answer.Results) < 5 {
		t.Fatalf("%d %s: %v", recorder.Code, recorder.Body.String(), err)
	}
	e := answer.Results[4]
	if e.ID != "e" || e.Passed || e.Error != nil || string(e.Detail) != "null" || e.Advisory == nil ||
		!strings.HasPrefix(*e.Advisory, "The pattern matched only empty text (") {
		t.Fatalf("rule e: %+v (detail %s)", e, e.Detail)
	}
}

func TestEveryRegisteredRouteIsDocumentedAndEveryOperationRegistered(t *testing.T) {
	doc := loadSpec(t)
	routes := newTestServer(t).routes()
	if undocumented := undocumentedRoutes(doc, routes); len(undocumented) != 0 {
		t.Errorf("routes %s doesn't document: %v", specPath, undocumented)
	}
	if missing := unregisteredOperations(doc, routes); len(missing) != 0 {
		t.Errorf("operations %s documents that the server doesn't register: %v", specPath, missing)
	}
	var real []string
	for _, pattern := range routes {
		if !slices.Contains(catchAlls, pattern) {
			real = append(real, pattern)
		}
	}
	if len(real) != 4 {
		t.Errorf("the server registers %v, want health, evaluate, validate and lint", real)
	}
}

// The route walk fails on a route the file doesn't document.
func TestTheRouteWalkFailsOnAnUndocumentedRoute(t *testing.T) {
	doc := loadSpec(t)
	base := newTestServer(t).routes()
	for _, extra := range []string{"GET /ottl/v1/functions", "GET " + evaluatePath, "POST " + healthPath, "/any-method"} {
		undocumented := undocumentedRoutes(doc, append(append([]string(nil), base...), extra))
		if len(undocumented) != 1 || !strings.HasSuffix(undocumented[0], extra) {
			t.Errorf("with %q registered, the walk found %v", extra, undocumented)
		}
	}
}

// The reply validation the test relies on is strict: a member missing, one
// too many, a cap passed or a kind unknown fails.
func TestTheReplyValidationCatchesAMalformedReply(t *testing.T) {
	doc := loadSpec(t)
	router, err := gorillamux.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	cases := conformanceCases()
	c := cases[1] // evaluate every detail
	ts := newTestServer(t)
	recorder := httptest.NewRecorder()
	ts.handler.ServeHTTP(recorder, c.newRequest())
	if recorder.Code != 200 {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
	route, pathParams, err := router.FindRoute(c.newRequest())
	if err != nil {
		t.Fatal(err)
	}
	type reply = map[string]any
	results := func(r reply) []any { return r["results"].([]any) }
	result := func(r reply, i int) reply { return results(r)[i].(reply) }
	detail := func(r reply, i int) reply { return result(r, i)["detail"].(reply) }
	match := func(r reply) reply { return detail(r, 2)["matches"].([]any)[0].(reply) }
	variants := map[string]func(reply){
		"results missing":               func(r reply) { delete(r, "results") },
		"an extra member":               func(r reply) { r["extra"] = 1 },
		"a result without detail":       func(r reply) { delete(result(r, 0), "detail") },
		"a result with an extra member": func(r reply) { result(r, 0)["line"] = 1 },
		"an unknown detail kind":        func(r reply) { detail(r, 1)["kind"] = "nothing" },
		"a detail with an extra member": func(r reply) { detail(r, 1)["matches"] = []any{} },
		"a match text over 200":         func(r reply) { match(r)["text"] = strings.Repeat("x", 201) },
		"a match before over 40":        func(r reply) { match(r)["before"] = strings.Repeat("x", 41) },
		"a negative record index":       func(r reply) { match(r)["record"].(reply)["index"] = -1 },
		"a record of both shapes":       func(r reply) { match(r)["record"].(reply)["line"] = 1 },
		"six matches": func(r reply) {
			d := detail(r, 2)
			m := d["matches"].([]any)[0]
			d["matches"] = []any{m, m, m, m, m, m}
		},
		"an error over 4,096 characters": func(r reply) { result(r, 9)["error"] = strings.Repeat("e", 4097) },
		"a sample over 120":              func(r reply) { detail(r, 7)["samples"] = []any{strings.Repeat("s", 121)} },
	}
	for label, change := range variants {
		var r reply
		if err := json.Unmarshal(recorder.Body.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		change(r)
		bad, _ := json.Marshal(r)
		input := &openapi3filter.ResponseValidationInput{
			RequestValidationInput: &openapi3filter.RequestValidationInput{
				Request: c.newRequest(), PathParams: pathParams, Route: route, Options: validationOptions(),
			},
			Status:  http.StatusOK,
			Header:  http.Header{"Content-Type": {jsonType}},
			Body:    io.NopCloser(bytes.NewReader(bad)),
			Options: validationOptions(),
		}
		if err := openapi3filter.ValidateResponse(context.Background(), input); err == nil {
			t.Errorf("a reply with %s passed validation", label)
		}
	}
}

// kin-openapi is a test-only dependency (Ruling 30): the license check scans
// the binary's modules, so no file but a test may import it.
func TestKinOpenAPIIsATestOnlyDependency(t *testing.T) {
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()
	checked := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		checked++
		for _, spec := range file.Imports {
			if strings.Contains(spec.Path.Value, "github.com/getkin/") {
				t.Errorf("%s imports %s", path, spec.Path.Value)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 20 {
		t.Fatalf("only %d Go files checked: is %s the module?", checked, root)
	}
}
