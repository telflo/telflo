// New in D15a Task 2 (plan Preflight ruling 12): the process refuses to
// start without a valid secret (there is no running without one), with OTTL_EVALUATOR_SECRET set, or with a secret's text in any
// environment variable; the settings refuse what doesn't parse; healthcheck.
// D25 Task 3 added the lint's body cap and deadline to the settings' test.

package server

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// env is a fake environment.
type env map[string]string

func (e env) get(name string) string { return e[name] }

func (e env) list() []string {
	var out []string
	for k, v := range e {
		out = append(out, k+"="+v)
	}
	return out
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestServeRefusesToStartWithoutAValidSecret(t *testing.T) {
	good := writeFile(t, testSecret+"\n")
	cases := []struct {
		name string
		env  env
		want string
	}{
		{"no secret file named", env{}, SecretFileVariable + " is not set"},
		{"the file is missing", env{SecretFileVariable: filepath.Join(t.TempDir(), "nope")}, SecretFileVariable + ": the file can't be read"},
		{"the file is empty", env{SecretFileVariable: writeFile(t, " \n")}, SecretFileVariable + ": the file holds no secret"},
		{"the secret is short", env{SecretFileVariable: writeFile(t, strings.Repeat("s", 31)+"\n")}, "at least 32 bytes"},
		{"a previous secret is short", env{SecretFileVariable: good, PreviousSecretsFileVariable: writeFile(t, previousSecret+"\n\nshort\n")}, "secret 2 of 2 must be at least 32 bytes"},
		{"the previous file is missing", env{SecretFileVariable: good, PreviousSecretsFileVariable: "/nonexistent/previous"}, PreviousSecretsFileVariable + ": the file can't be read"},
		{"OTTL_EVALUATOR_SECRET set", env{SecretFileVariable: good, SecretValueVariable: testSecret}, SecretValueVariable + " is set"},
		{"OTTL_EVALUATOR_SECRET set but empty", env{SecretFileVariable: good, SecretValueVariable: ""}, SecretValueVariable + " is set"},
		{"the secret in another variable", env{SecretFileVariable: good, "SOMETHING": "prefix-" + testSecret}, "a secret is also in the environment"},
		{"a previous secret in a variable", env{SecretFileVariable: good, PreviousSecretsFileVariable: writeFile(t, previousSecret), "OTHER": previousSecret}, "a secret is also in the environment"},
		{"a cap that doesn't parse", env{SecretFileVariable: good, MaxEvaluationsVariable: "four"}, MaxEvaluationsVariable + " must be a whole number from 1 to 4"},
		{"more evaluations than the ruling's", env{SecretFileVariable: good, MaxEvaluationsVariable: "5"}, MaxEvaluationsVariable + " must be a whole number from 1 to 4"},
		{"more validations than the ruling's", env{SecretFileVariable: good, MaxValidationsVariable: "9"}, MaxValidationsVariable + " must be a whole number from 1 to 8"},
		{"a cap raised past its ruling", env{SecretFileVariable: good, MaxEvaluateBodyVariable: "37748737"}, MaxEvaluateBodyVariable + " must be a whole number"},
		{"a host that isn't an IP address", env{SecretFileVariable: good, HostVariable: "localhost"}, HostVariable + " must be an IP address"},
	}
	for _, c := range cases {
		var logs bytes.Buffer
		code := Serve(context.Background(), c.env.get, c.env.list(), slog.New(slog.NewJSONHandler(&logs, nil)))
		if code != 1 || !strings.Contains(logs.String(), c.want) {
			t.Errorf("%s: exit %d, log %s", c.name, code, logs.String())
		}
		for _, secret := range []string{testSecret, previousSecret} {
			if strings.Contains(logs.String(), secret) {
				t.Errorf("%s: the log holds a secret", c.name)
			}
		}
	}
}

func TestSecretsLoadFromTheirFiles(t *testing.T) {
	e := env{
		SecretFileVariable:          writeFile(t, "  "+testSecret+"\n"),
		PreviousSecretsFileVariable: writeFile(t, "\n"+previousSecret+"\n  \n"+strings.Repeat("p", 40)+"\n"),
	}
	secrets, err := LoadSecrets(e.get, e.list())
	if err != nil {
		t.Fatal(err)
	}
	if secrets.count() != 3 || !secrets.Accepts(testSecret) || !secrets.Accepts(previousSecret) || !secrets.Accepts(strings.Repeat("p", 40)) {
		t.Fatalf("count %d", secrets.count())
	}
	for _, token := range []string{"", testSecret + " ", testSecret[1:], strings.Repeat("p", 41)} {
		if secrets.Accepts(token) {
			t.Errorf("accepted a %d-byte token", len(token))
		}
	}
}

func TestSettingsDefaultsAndLimits(t *testing.T) {
	s, err := LoadSettings(env{}.get)
	if err != nil {
		t.Fatal(err)
	}
	if s != DefaultSettings() || s.Port != 8003 || s.MaxEvaluations != 4 || s.MaxValidations != 8 ||
		s.MaxEvaluateBodyBytes != 36<<20 || s.MaxValidateBodyBytes != 64<<10 || s.MaxOutputObjects != 1_000_000 ||
		s.EvaluateWait.Seconds() != 5 || s.ValidateWait.Seconds() != 1 ||
		s.EvaluateSoftDeadline.Seconds() != 20 || s.EvaluateHardDeadline.Seconds() != 25 || s.ValidateHardDeadline.Seconds() != 2 ||
		s.MaxLintBodyBytes != 10<<20 || s.LintHardDeadline.Seconds() != 10 {
		t.Fatalf("defaults: %+v", s)
	}
	s, err = LoadSettings(env{
		PortVariable: "56551", HostVariable: "127.0.0.1", MaxEvaluationsVariable: "2", MaxValidationsVariable: "3",
		MaxEvaluateBodyVariable: "1048576", MaxValidateBodyVariable: "1024", MaxOutputObjectsVariable: "10",
		MaxLintBodyVariable: "2048",
	}.get)
	if err != nil || s.Port != 56551 || s.Host != "127.0.0.1" || s.MaxEvaluations != 2 || s.MaxValidations != 3 ||
		s.MaxEvaluateBodyBytes != 1<<20 || s.MaxValidateBodyBytes != 1024 || s.MaxOutputObjects != 10 || s.MaxLintBodyBytes != 2048 {
		t.Fatalf("set: %+v %v", s, err)
	}
	for variable, value := range map[string]string{
		PortVariable: "0", MaxEvaluationsVariable: "65", MaxValidationsVariable: "0",
		MaxValidateBodyVariable: "65537", MaxOutputObjectsVariable: "1000001", MaxEvaluateBodyVariable: "-1",
		MaxLintBodyVariable: "10485761",
	} {
		if _, err := LoadSettings(env{variable: value}.get); err == nil || strings.Contains(err.Error(), value) {
			t.Errorf("%s=%s: %v", variable, value, err)
		}
	}
}

func TestHealthcheckAsksTheServersHealth(t *testing.T) {
	ts := newTestServer(t)
	server := httptest.NewServer(ts.handler)
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	if code := Healthcheck(context.Background(), env{PortVariable: port}.get, logger); code != 0 {
		t.Fatalf("healthy: exit %d, %s", code, logs.String())
	}
	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer unhealthy.Close()
	_, port, _ = net.SplitHostPort(unhealthy.Listener.Addr().String())
	if code := Healthcheck(context.Background(), env{PortVariable: port}.get, logger); code != 1 {
		t.Fatalf("unhealthy: exit %d", code)
	}
}
