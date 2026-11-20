// The child processes. A Go regexp call and OTTL's parser can't be
// interrupted (one pattern measured 52 s per MiB; `Concat([` twenty deep,
// 37 s to parse), so each evaluate and validate request's work runs in a
// child process of the same binary, which the server kills at its limit. The
// child reads the checked request on stdin and writes one JSON line per
// finished rule (evaluate) or per step (validate) on stdout, flushed as it
// goes, so the lines written before a kill survive it. It runs with an empty
// environment but GOMEMLIMIT and GOMAXPROCS (internal/server's
// childEnvironment), in its own process group, and asks the kernel to kill
// it first when memory runs out (oom_score_adj 1000, Linux only).

package rules

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"time"
)

// The child's exit codes. Anything else (a Go runtime's fatal error exits 2)
// is the server's to judge.
const (
	ExitDone     = 0
	ExitDeadline = 3 // the evaluation's deadline passed: the rules without a line are unfinished
	ExitInput    = 4 // the input couldn't be read
	ExitSetup    = 5 // oom_score_adj couldn't be set
)

// EvaluateHeader is the first line an evaluate child reads; the output's
// bytes (OutputBytes of them) follow it.
type EvaluateHeader struct {
	Input
	OutputBytes int `json:"outputBytes"`
	// SoftDeadline is how long the child may work before it stops between
	// two checkpoints: 20 s in production.
	SoftDeadline time.Duration `json:"softDeadline"`
}

// ValidateInput is a validate child's one line.
type ValidateInput struct {
	Signal string `json:"signal"`
	Rule   Rule   `json:"rule"`
}

// ValidateLine is one line a validate child writes: Checking names the
// field about to be parsed or compiled; the last line has Problems (an
// empty list when the rule is valid).
type ValidateLine struct {
	Checking string     `json:"checking,omitempty"`
	Problems *[]Problem `json:"problems,omitempty"`
}

// oomScoreFile is where a Linux process raises its own oom_score_adj.
const oomScoreFile = "/proc/self/oom_score_adj"

// preferOOMKill asks the kernel to kill this process first when memory runs
// out. Where the file doesn't exist (macOS), there is nothing to ask.
func preferOOMKill() error {
	f, err := os.OpenFile(oomScoreFile, os.O_WRONLY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = f.WriteString("1000")
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

// RunEvaluateChild is the evaluate-child subcommand: it returns the
// process's exit code. now is the clock its soft deadline reads.
func RunEvaluateChild(stdin io.Reader, stdout io.Writer, now func() time.Time) int {
	if preferOOMKill() != nil {
		return ExitSetup
	}
	start := now()
	in := bufio.NewReaderSize(stdin, 64<<10)
	line, err := in.ReadBytes('\n')
	if err != nil {
		return ExitInput
	}
	var header EvaluateHeader
	if err := json.Unmarshal(line, &header); err != nil || header.OutputBytes < 0 || header.OutputBytes > MaxOutputBytes {
		return ExitInput
	}
	output := make([]byte, header.OutputBytes)
	if _, err := io.ReadFull(in, output); err != nil {
		return ExitInput
	}

	deadline := start.Add(header.SoftDeadline)
	check := func() error {
		if !now().Before(deadline) {
			return ErrDeadline
		}
		return nil
	}
	out := bufio.NewWriter(stdout)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	emit := func(result Result) error {
		if err := enc.Encode(result); err != nil {
			return err
		}
		return out.Flush()
	}
	switch err := Evaluate(header.Input, output, check, emit); {
	case errors.Is(err, ErrDeadline):
		return ExitDeadline
	case err != nil:
		return ExitInput
	}
	return ExitDone
}

// RunValidateChild is the validate-child subcommand: it checks one rule,
// writing a line before each slow step and its problems last.
func RunValidateChild(stdin io.Reader, stdout io.Writer) int {
	if preferOOMKill() != nil {
		return ExitSetup
	}
	var input ValidateInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return ExitInput
	}
	out := bufio.NewWriter(stdout)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	write := func(line ValidateLine) {
		_ = enc.Encode(line)
		_ = out.Flush()
	}
	problems := Check(input.Signal, input.Rule, false, func(field string) {
		write(ValidateLine{Checking: field})
	})
	if problems == nil {
		problems = []Problem{}
	}
	write(ValidateLine{Problems: &problems})
	return ExitDone
}
