package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

func contextWithCancel() (context.Context, context.CancelFunc) {
	return context.WithCancel(context.Background())
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

const logsPayload = `{"resourceLogs":[{"resource":{},"scopeLogs":[{"scope":{},"logRecords":[{"timeUnixNano":"1","body":{"stringValue":"hello"}}]}]}]}`

func TestHealthNeedsNoAuth(t *testing.T) {
	ts := newTestServer(t)
	rec := ts.call(http.MethodGet, "/health", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("health should be open, got %d", rec.Code)
	}
	var health map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil || health["status"] != "ok" || health["ottlVersion"] == "" || len(health) != 2 {
		t.Fatalf("health: %s", rec.Body.String())
	}
}

// GET /health logs nothing: the kubelet's probes and the API's health
// monitor call it every few seconds (D33-1 decision 18, Ruling 335). Every
// other request, on the health path or not, keeps its one line.
func TestAHealthCheckWritesNoLogLine(t *testing.T) {
	ts := newTestServer(t)
	for _, target := range []string{"/health", "/health?x=1"} {
		if rec := ts.call(http.MethodGet, target, "", ""); rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d", target, rec.Code)
		}
	}
	if logs := ts.logs.String(); logs != "" {
		t.Fatalf("a health check is logged: %s", logs)
	}
	others := []struct{ method, target, route string }{
		{http.MethodHead, "/health", "GET /health"},
		{http.MethodPost, "/health", "/health"},
		{http.MethodGet, "/health/", "unmatched"},
		{http.MethodGet, "/nowhere", "unmatched"},
		{http.MethodPost, evaluatePath, "POST " + evaluatePath},
	}
	for _, c := range others {
		before := strings.Count(ts.logs.String(), `"msg":"request"`)
		ts.call(c.method, c.target, "{}", testSecret)
		logs := ts.logs.String()
		if strings.Count(logs, `"msg":"request"`) != before+1 {
			t.Errorf("%s %s: not one request line: %s", c.method, c.target, logs)
		}
		if !strings.Contains(logs, `"method":"`+c.method+`","route":"`+c.route+`"`) {
			t.Errorf("%s %s: no line for route %q: %s", c.method, c.target, c.route, logs)
		}
	}
}

func TestAWrongSecretIsRefused(t *testing.T) {
	ts := newTestServer(t)
	for _, token := range []string{"wrong", testSecret + "x", strings.ToUpper(testSecret), testSecret[:31]} {
		rec := ts.call(http.MethodPost, "/ottl/v1/evaluate", "{}", token)
		if rec.Code != http.StatusUnauthorized || errorCode(t, rec) != codeUnauthorized {
			t.Fatalf("token %d bytes: %d %s", len(token), rec.Code, rec.Body.String())
		}
	}
}

func TestAMissingSecretIsRefused(t *testing.T) {
	ts := newTestServer(t)
	for name, header := range map[string][]string{
		"no header":      nil,
		"another scheme": {"Basic " + testSecret},
		"no token":       {"Bearer "},
		"two headers":    {"Bearer " + testSecret, "Bearer " + testSecret},
		"no scheme":      {testSecret},
	} {
		req := httptest.NewRequest(http.MethodPost, "/ottl/v1/validate", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		for _, value := range header {
			req.Header.Add("Authorization", value)
		}
		rec := httptest.NewRecorder()
		ts.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") != "Bearer" || rec.Header().Get("Connection") != "close" {
			t.Errorf("%s: %d %v", name, rec.Code, rec.Header())
		}
	}
	// The scheme's case doesn't matter (RFC 9110).
	req := httptest.NewRequest(http.MethodGet, "/nowhere", nil)
	req.Header.Set("Authorization", "bearer "+testSecret)
	rec := httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("lower-case bearer: %d", rec.Code)
	}
}

func TestThePreviousSecretIsAccepted(t *testing.T) {
	ts := newTestServer(t)
	rec := ts.call(http.MethodGet, "/nowhere", "", previousSecret)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("the previous secret: %d", rec.Code)
	}
	body := `{"signal":"logs","rule":{"kind":"contains_text","target":"output","pattern":"x"}}`
	if rec := ts.call(http.MethodPost, "/ottl/v1/validate", body, previousSecret); rec.Code != http.StatusOK {
		t.Fatalf("validate with the previous secret: %d %s", rec.Code, rec.Body.String())
	}
}

// The secret is checked before routing: without it, an unknown path, an
// unknown method and a known route all answer the same 401, never 404 or
// 405, so nothing about the routes leaks.
func TestAnUnknownPathWithoutTheSecretIs401Not404(t *testing.T) {
	ts := newTestServer(t)
	for _, c := range []struct{ method, target string }{
		{http.MethodGet, "/nowhere"},
		{http.MethodGet, "/ottl/v1/functions"},
		{http.MethodPost, "/ottl/v1/evaluate/"},
		{http.MethodGet, "/ottl/v1/evaluate"},
		{http.MethodPost, "/health"},
		{http.MethodHead, "/health"},
		{http.MethodGet, "/health/"},
		{http.MethodGet, "/./health"},
	} {
		rec := ts.call(c.method, c.target, "", "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without the secret: %d", c.method, c.target, rec.Code)
		}
		withSecret := ts.call(c.method, c.target, "", testSecret)
		if withSecret.Code == http.StatusUnauthorized {
			t.Errorf("%s %s with the secret: 401", c.method, c.target)
		}
	}
	if rec := ts.call(http.MethodGet, "/nowhere", "", testSecret); rec.Code != http.StatusNotFound || errorCode(t, rec) != codeNotFound {
		t.Errorf("an unknown path with the secret: %d %s", rec.Code, rec.Body.String())
	}
	if rec := ts.call(http.MethodGet, "/ottl/v1/evaluate", "", testSecret); rec.Code != http.StatusMethodNotAllowed || errorCode(t, rec) != codeMethodNotAllowed {
		t.Errorf("GET evaluate with the secret: %d %s", rec.Code, rec.Body.String())
	}
}

// recordingBody counts reads of a request's body.
type recordingBody struct {
	reads atomic.Int32
	r     io.Reader
}

func (b *recordingBody) Read(p []byte) (int, error) {
	b.reads.Add(1)
	return b.r.Read(p)
}

func TestA401ReadsNoBody(t *testing.T) {
	ts := newTestServer(t)
	body := &recordingBody{r: strings.NewReader(evaluateBody("logs", nil, "", textRuleJSON("r1", "contains_text", "output", "x")))}
	req := httptest.NewRequest(http.MethodPost, "/ottl/v1/evaluate", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ts.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || body.reads.Load() != 0 {
		t.Fatalf("status %d, %d reads of the body", rec.Code, body.reads.Load())
	}
}

func TestEvaluateHappyPath(t *testing.T) {
	ts := newTestServer(t)
	output := logsPayload
	body := evaluateBody("logs", &output, "", ottlRuleJSON("r1", "log", "all", `body == "hello"`))
	a := decodeAnswer(t, ts.post("/ottl/v1/evaluate", body))
	if len(a.Results) != 1 || !a.Results[0].Passed || a.Results[0].ID != "r1" {
		t.Fatalf("expected one passing result, got %+v", a.Results)
	}
	if a.OTTLVersion == "" {
		t.Errorf("ottlVersion should be set")
	}
}

// Every kind in one request, each result by id in the request's order.
func TestEvaluateAnswersEveryKindInOrder(t *testing.T) {
	ts := newTestServer(t)
	output := `{"records":[` + logsPayload + `,` + logsPayload + `]}`
	body := evaluateBody("logs", &output, "INFO started\nWARN dropped 3\n",
		textRuleJSON("t1", "contains_text", "output", `"stringValue": "hello"`),
		textRuleJSON("t2", "not_contains_text", "stderr", "dropped"),
		textRuleJSON("t3", "contains_regex", "output", `"timeUnixNano":"\d+"`),
		textRuleJSON("t4", "not_contains_regex", "stderr", `ERROR|FATAL`),
		ottlRuleJSON("o1", "log", "all", `body == "hello"`),
		`{"id":"o2","kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"count","condition":"true","count":{"operator":"eq","value":2}}}`,
	)
	a := decodeAnswer(t, ts.post("/ottl/v1/evaluate", body))
	want := []struct {
		id     string
		passed bool
	}{{"t1", true}, {"t2", false}, {"t3", true}, {"t4", true}, {"o1", true}, {"o2", true}}
	if len(a.Results) != len(want) {
		t.Fatalf("%d results", len(a.Results))
	}
	for i, w := range want {
		r := a.Results[i]
		if r.ID != w.id || r.Passed != w.passed || r.Error != nil {
			t.Errorf("result %d: %+v, want %s passed=%v", i, r, w.id, w.passed)
		}
	}
	var detail struct {
		Matches []struct {
			Record map[string]any `json:"record"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(a.Results[1].Detail, &detail); err != nil || detail.Matches[0].Record["line"] != float64(2) {
		t.Errorf("the log's match: %s", a.Results[1].Detail)
	}
}

func TestValidateEndpoint(t *testing.T) {
	ts := newTestServer(t)
	for _, c := range []struct {
		name, rule string
		valid      bool
		field      string
	}{
		{"a valid condition", `{"kind":"ottl","target":"output","ottl":{"context":"span","quantifier":"all","condition":"attributes[\"a\"] == \"b\""}}`, true, ""},
		{"a broken condition", `{"kind":"ottl","target":"output","ottl":{"context":"span","quantifier":"all","condition":"nope("}}`, false, rules.FieldCondition},
		{"a regex RE2 refuses", `{"kind":"contains_regex","target":"output","pattern":"(?=x)"}`, false, rules.FieldPattern},
		{"a valid regex", `{"kind":"not_contains_regex","target":"stderr","pattern":"\\bERROR\\b"}`, true, ""},
		{"a text of only whitespace", `{"kind":"contains_text","target":"output","pattern":"   "}`, false, rules.FieldPattern},
		{"a context traces lacks", `{"kind":"ottl","target":"output","ottl":{"context":"log","quantifier":"all","condition":"true"}}`, false, rules.FieldContext},
	} {
		rec := ts.post("/ottl/v1/validate", `{"signal":"traces","rule":`+c.rule+`}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
		var a struct {
			Valid       bool             `json:"valid"`
			Problems    *[]rules.Problem `json:"problems"`
			OTTLVersion string           `json:"ottlVersion"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
			t.Fatal(err)
		}
		if a.Valid != c.valid || a.OTTLVersion == "" {
			t.Errorf("%s: %s", c.name, rec.Body.String())
		}
		if c.valid && a.Problems != nil {
			t.Errorf("%s: a valid rule has no problems member: %s", c.name, rec.Body.String())
		}
		if !c.valid && (a.Problems == nil || len(*a.Problems) == 0 || (*a.Problems)[0].Field != c.field || (*a.Problems)[0].Message == "") {
			t.Errorf("%s: %s", c.name, rec.Body.String())
		}
	}
}

// D15a Task 1 (spec decision 10): GET /ottl/v1/functions had no caller and
// is gone. With the secret, so that the 404 is the route's absence and not
// the secret's refusal; without it, 401 (TestAnUnknownPathWithoutTheSecretIs401Not404).
func TestFunctionsEndpointIsGone(t *testing.T) {
	ts := newTestServer(t)
	for _, target := range []string{"/ottl/v1/functions", "/ottl/v1/functions?context=log"} {
		rec := ts.call(http.MethodGet, target, "", testSecret)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s: expected 404, got %d: %s", target, rec.Code, rec.Body.String())
		}
		if rec := ts.call(http.MethodGet, target, "", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without the secret: expected 401, got %d", target, rec.Code)
		}
	}
}

// A retired kind or an unknown one isn't one of the five, so each is refused by
// the request's shape, the whole request, never evaluated (plan Preflight
// rulings 9 and 14): no rule of them can pass.
func TestRetiredAndUnknownKindsAreRefused(t *testing.T) {
	ts := newTestServer(t)
	output := "{}"
	for _, kind := range []string{
		"cardinality", "record_count_diff", "attribute_added_on_all", "attribute_removed_on_all",
		"attribute_modified", "record_count", "record_attribute", // the retired
		"contains_json", "not_contains_json", // the JSON rules, retired
		"future_rule_we_dont_have", // unknown
	} {
		for _, target := range []string{"output", "stderr"} {
			body := evaluateBody("metrics", &output, "x", textRuleJSON("r1", kind, target, `{"a": 1}`))
			rec := ts.post("/ottl/v1/evaluate", body)
			if rec.Code != http.StatusBadRequest || errorCode(t, rec) != codeInvalidRequest {
				t.Errorf("%s on %s: %d %s", kind, target, rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), kind) {
				t.Errorf("the refusal quotes the request: %s", rec.Body.String())
			}
		}
	}
}

func TestAContentProblemIsTheRulesErrorNotTheRequests(t *testing.T) {
	ts := newTestServer(t)
	output := logsPayload
	body := evaluateBody("logs", &output, "",
		textRuleJSON("r1", "contains_regex", "output", "(unclosed"),
		ottlRuleJSON("r2", "span", "all", "true"),
		ottlRuleJSON("r3", "log", "all", `attributes[`),
		textRuleJSON("r4", "contains_text", "output", "hello"),
	)
	a := decodeAnswer(t, ts.post("/ottl/v1/evaluate", body))
	if !strings.HasPrefix(resultError(a.Results[0]), "Invalid regex: ") ||
		!strings.Contains(resultError(a.Results[1]), `"span" context`) ||
		!strings.HasPrefix(resultError(a.Results[2]), "OTTL syntax error: ") ||
		!a.Results[3].Passed {
		t.Fatalf("%+v", a.Results)
	}
}
