// New in D15a Task 3 (plan Preflight ruling 13; the ledger's A4e): the
// selfcheck subcommand, which checks the running container from the inside.
// The image is distroless, with no shell or Python to pipe a probe into (the
// collector tester's scripts/container-probe.py), so the binary carries its
// own: scripts/check-container.sh runs `ottl-evaluator selfcheck` in the
// container with `docker compose exec`, as the container's user.
//
// This file holds the parts that only read text (/proc's status and mounts,
// the environment, a child's answer), tested on any system; the checks
// themselves read /proc and are Linux's (selfcheck_linux.go). D15a Task 3's
// follow-up (the controller's Ruling 34) adds the network's positive control,
// selfcheckOwnName and resolvesToSelf.

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

// SelfcheckCommand is the subcommand's name (cmd/server).
const SelfcheckCommand = "selfcheck"

const (
	// containerUser is distroless's nonroot user and group (65532), the
	// image's USER.
	containerUser = 65532
	// selfcheckDialTimeout bounds each attempt to reach the outside: an
	// internal network drops the packets, so an attempt ends at it.
	selfcheckDialTimeout = 3 * time.Second
	// selfcheckChildLimit bounds the evaluate child the check starts (it
	// answers in milliseconds).
	selfcheckChildLimit = 10 * time.Second
	// serveCommandLine is PID 1's command line: the image's ENTRYPOINT and
	// compose's command.
	serveCommandLine = "/app/ottl-evaluator serve"
)

// The outside the container must not reach: Cloudflare's and Google's
// resolvers answer from any network with a route out, and the name resolves
// from any. Those checks pass by failing (an internal network drops the
// packets, so a dial or a lookup ends at selfcheckDialTimeout), so they are
// preceded by a positive control: the evaluator's own compose service name,
// selfcheckOwnName, resolves through Docker's DNS to this container, and
// serve answers on it. A lookup or a dial that fails afterwards fails
// because the outside is blocked, not because DNS or the network doesn't
// work at all.
var (
	selfcheckAddresses = []string{"1.1.1.1:443", "8.8.8.8:53"}
	selfcheckName      = "example.com"
	selfcheckOwnName   = "ottl-evaluator"
)

// capabilitySets are /proc/<pid>/status's capability lines: compose's
// `cap_drop: [ALL]` empties the bounding set too, not only the effective one.
var capabilitySets = []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}

// checkReport prints one line per check, "ok <check>" or "FAIL <check>:
// <why>", and counts the failures. No line quotes a secret.
type checkReport struct {
	out    io.Writer
	failed int
}

func (r *checkReport) check(name string, passed bool, why string) {
	if passed {
		fmt.Fprintf(r.out, "ok %s\n", name)
		return
	}
	r.failed++
	fmt.Fprintf(r.out, "FAIL %s: %s\n", name, why)
}

// finish prints the summary and returns the exit code: 1 when any check
// failed.
func (r *checkReport) finish() int {
	if r.failed > 0 {
		fmt.Fprintf(r.out, "%d check(s) failed\n", r.failed)
		return 1
	}
	fmt.Fprintln(r.out, "every check passed")
	return 0
}

// resolvesToSelf says whether one of a lookup's addresses is one of this
// container's own (its interfaces'), and, when none is, what it found.
func resolvesToSelf(resolved []string, own []net.Addr) (bool, string) {
	if len(resolved) == 0 {
		return false, "no address"
	}
	for _, address := range resolved {
		ip := net.ParseIP(address)
		for _, a := range own {
			var mine net.IP
			switch a := a.(type) {
			case *net.IPNet:
				mine = a.IP
			case *net.IPAddr:
				mine = a.IP
			}
			if ip != nil && mine.Equal(ip) {
				return true, ""
			}
		}
	}
	return false, "resolved to " + strings.Join(resolved, " ") + ", not this container's address"
}

// parseProcStatus reads /proc/<pid>/status's "Name:\tvalue" lines.
func parseProcStatus(text string) map[string]string {
	fields := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		name, value, found := strings.Cut(line, ":")
		if found {
			fields[name] = strings.TrimSpace(value)
		}
	}
	return fields
}

// privilegesHeld lists what a process's status says it may still gain or
// use: every capability set that isn't empty, and NoNewPrivs that isn't 1.
// A line that is missing or doesn't parse counts as held.
func privilegesHeld(fields map[string]string) []string {
	var held []string
	for _, set := range capabilitySets {
		mask, err := strconv.ParseUint(fields[set], 16, 64)
		if err != nil || mask != 0 {
			held = append(held, set+" "+fields[set])
		}
	}
	if fields["NoNewPrivs"] != "1" {
		held = append(held, "NoNewPrivs "+fields["NoNewPrivs"])
	}
	return held
}

// statusUser is the real uid of a process's status (its Uid line's first
// field), or "" when it has none.
func statusUser(fields map[string]string) string {
	ids := strings.Fields(fields["Uid"])
	if len(ids) == 0 {
		return ""
	}
	return ids[0]
}

// rootMountOptions are the options of the mount at / that is in effect: the
// LAST line of /proc/self/mounts for it (a later mount over the same point
// hides the earlier ones). nil when there is none.
func rootMountOptions(mounts string) []string {
	var options []string
	for _, line := range strings.Split(mounts, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 4 && fields[1] == "/" {
			options = strings.Split(fields[3], ",")
		}
	}
	return options
}

// hasOption says whether a mount's options include option.
func hasOption(options []string, option string) bool {
	for _, o := range options {
		if o == option {
			return true
		}
	}
	return false
}

// refusedVariables names the environment's variables that would carry a
// secret's text: OTTL_EVALUATOR_SECRET itself and anything else starting
// with it, but the two variables that name the secrets' files.
func refusedVariables(environ []string) []string {
	var refused []string
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, SecretValueVariable) {
			continue
		}
		if name == SecretFileVariable || name == PreviousSecretsFileVariable {
			continue
		}
		refused = append(refused, name)
	}
	return refused
}

// commandLine joins /proc/<pid>/cmdline's NUL-separated arguments with
// spaces.
func commandLine(raw []byte) string {
	return strings.Join(strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00"), " ")
}

// selfcheckChildInput is the evaluate child's input for the check: a text
// rule on the log and an OTTL rule on a one-record output, both passing.
func selfcheckChildInput() []byte {
	output := []byte(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"selfcheck"}}]}]}]}`)
	text, condition := "selfcheck started", `body == "selfcheck"`
	header, err := json.Marshal(rules.EvaluateHeader{
		Input: rules.Input{
			Signal:           "logs",
			OutputPresent:    true,
			Log:              "selfcheck started\n",
			MaxOutputObjects: rules.DefaultMaxOutputObjects,
			Rules: []rules.Rule{
				{ID: "text", Kind: rules.KindContainsText, Target: rules.TargetStderr, Pattern: &text},
				{ID: "ottl", Kind: rules.KindOTTL, Target: rules.TargetOutput,
					OTTL: &rules.OTTL{Context: "log", Quantifier: "all", Condition: &condition}},
			},
		},
		OutputBytes:  len(output),
		SoftDeadline: selfcheckChildLimit,
	})
	if err != nil {
		panic(err) // a fixed value: it always encodes
	}
	return append(append(header, '\n'), output...)
}

// runSelfcheckChild runs an evaluate child as serve does (childRunner: the
// same binary, its own process group, the children's environment), with
// selfcheckChildInput, and says whether it raised its oom_score_adj (it
// exits ExitSetup when it can't) and answered both rules passed.
func runSelfcheckChild(ctx context.Context, command []string) (bool, string) {
	runner := childRunner{
		command:   command,
		afterFunc: func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop },
	}
	outcome := runner.run(ctx, EvaluateChildCommand, bytes.NewReader(selfcheckChildInput()), selfcheckChildLimit, 2)
	switch {
	case outcome.end == childExited && outcome.exitCode == rules.ExitSetup:
		return false, "the child couldn't set its oom_score_adj"
	case outcome.end != childExited || outcome.exitCode != rules.ExitDone:
		return false, fmt.Sprintf("the child ended %d with exit code %d", outcome.end, outcome.exitCode)
	case len(outcome.lines) != 2:
		return false, fmt.Sprintf("the child answered %d results, want 2", len(outcome.lines))
	}
	for _, line := range outcome.lines {
		var result rules.Result
		if err := json.Unmarshal(line, &result); err != nil || !result.Passed {
			return false, "a rule didn't pass: " + string(line)
		}
	}
	return true, ""
}
