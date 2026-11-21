// Main dispatches its subcommands, the children's (lint-child among them)
// included.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

func noEnv(string) string { return "" }

func TestRunRefusesAnUnknownCommandLine(t *testing.T) {
	for _, args := range [][]string{nil, {"nope"}, {"serve", "extra"}, {"-healthcheck"}} {
		var out bytes.Buffer
		if code := run(context.Background(), args, noEnv, nil, strings.NewReader(""), &out); code != 2 || !strings.Contains(out.String(), "usage") {
			t.Errorf("%v: exit %d, %s", args, code, out.String())
		}
	}
}

func TestRunServeRefusesWithoutASecret(t *testing.T) {
	dumpableAgainAfter(t)
	var out bytes.Buffer
	if code := run(context.Background(), []string{"serve"}, noEnv, nil, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "OTTL_EVALUATOR_SECRET_FILE is not set") {
		t.Fatalf("exit %d, %s", code, out.String())
	}
}

func TestRunDispatchesTheChildren(t *testing.T) {
	header, _ := json.Marshal(rules.EvaluateHeader{
		Input:        rules.Input{Signal: "logs", Log: "hello", MaxOutputObjects: 10, Rules: []rules.Rule{{ID: "a", Kind: rules.KindContainsText, Target: rules.TargetStderr, Pattern: strPtr("hello")}}},
		SoftDeadline: 1 << 40,
	})
	var out bytes.Buffer
	if code := run(context.Background(), []string{"evaluate-child"}, noEnv, nil, bytes.NewReader(append(header, '\n')), &out); code != 0 || !strings.Contains(out.String(), `"id":"a","passed":true`) {
		t.Fatalf("evaluate-child: exit %d, %s", code, out.String())
	}
	out.Reset()
	in := `{"signal":"logs","rule":{"kind":"contains_regex","target":"output","pattern":"("}}`
	if code := run(context.Background(), []string{"validate-child"}, noEnv, nil, strings.NewReader(in), &out); code != 0 || !strings.Contains(out.String(), `"problems":[{"field":"pattern"`) {
		t.Fatalf("validate-child: exit %d, %s", code, out.String())
	}
	out.Reset()
	in = `{"context":"log","conditions":["attributes["]}`
	if code := run(context.Background(), []string{"lint-child"}, noEnv, nil, strings.NewReader(in), &out); code != 0 || !strings.Contains(out.String(), `{"kind":"condition","index":0,"valid":false,"error":"OTTL syntax error: `) {
		t.Fatalf("lint-child: exit %d, %s", code, out.String())
	}
}

func strPtr(s string) *string { return &s }
