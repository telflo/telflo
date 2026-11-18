// New in the follow-up to D15a Task 2's review (the controller's Ruling 33):
// `OPTIONS *` and paths that aren't in their cleaned form get the
// envelope, after the secret's check, never Go's own answers.

package server

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Go's http.Server answers `OPTIONS *` itself (200, no handler) unless its
// general OPTIONS handler is off; only a real listener shows which.
func TestOptionsStarIsRefusedOnARealListener(t *testing.T) {
	ts := newTestServer(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := newHTTPServer(ts.handler)
	go func() { _ = srv.Serve(listener) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), hangGuard)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	for _, c := range []struct {
		name, request string
		status        int
		code          string
	}{
		{"without the secret", "OPTIONS * HTTP/1.1\r\nHost: evaluator\r\nContent-Length: 4\r\n\r\nbody", http.StatusUnauthorized, codeUnauthorized},
		{"with the secret", "OPTIONS * HTTP/1.1\r\nHost: evaluator\r\nAuthorization: Bearer " + testSecret + "\r\n\r\n", http.StatusNotFound, codeNotFound},
	} {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(hangGuard))
		if _, err := io.WriteString(conn, c.request); err != nil {
			t.Fatal(err)
		}
		resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodOptions})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		_ = conn.Close()
		if resp.StatusCode != c.status || !strings.Contains(string(body), `"code":"`+c.code+`"`) {
			t.Errorf("OPTIONS * %s: %d %s", c.name, resp.StatusCode, body)
		}
	}
	if logs := ts.logs.String(); strings.Count(logs, `"method":"OPTIONS","route":"unmatched"`) != 2 {
		t.Errorf("each OPTIONS * gets its log line: %s", logs)
	}
}

// A path that isn't its cleaned form is 404 not_found with the secret (the
// mux would redirect it, in plain text), and 401 without it.
func TestAPathNotInItsCleanedFormIsNotFound(t *testing.T) {
	ts := newTestServer(t)
	for _, c := range []struct{ method, target string }{
		{http.MethodGet, "//health"},
		{http.MethodGet, "/x/../health"},
		{http.MethodGet, "/./health"},
		{http.MethodGet, "/health/"},
		{http.MethodPost, "/ottl/v1//evaluate"},
		{http.MethodPost, "/ottl/v1/evaluate/"},
		{http.MethodPost, "/ottl/v1/../v1/validate"},
	} {
		rec := ts.call(c.method, c.target, `{}`, testSecret)
		if rec.Code != http.StatusNotFound || errorCode(t, rec) != codeNotFound || rec.Header().Get("Location") != "" {
			t.Errorf("%s %s with the secret: %d %s", c.method, c.target, rec.Code, rec.Body.String())
		}
		if rec := ts.call(c.method, c.target, `{}`, ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without the secret: %d", c.method, c.target, rec.Code)
		}
	}
	if logs := ts.logs.String(); strings.Contains(logs, `"route":"GET /health"`) || strings.Contains(logs, `"route":"POST /ottl`) {
		t.Errorf("a refused path is logged as a route: %s", logs)
	}
}
