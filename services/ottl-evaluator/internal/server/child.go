// New in D15a Task 2 (plan Preflight ruling 10; ADR 0028's pattern): each
// evaluate and validate request's work runs in a child process of the same
// binary, in its own process group, with an empty environment but
// GOMEMLIMIT (and GOMAXPROCS, below). At its limit, or when its request or
// the server ends, the whole group is killed (SIGKILL) and reaped before
// the request's slot is freed. The child's lines are read as they come, so
// a kill keeps the rules already finished. The follow-up to Task 2's
// review (the controller's Ruling 33) added GOMAXPROCS=2 to the
// environment and, on Linux, Pdeathsig (child_linux.go). D25 Task 3 added
// the lint's child, lint-child.

package server

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"sync/atomic"
	"syscall"
	"time"
)

// The child's subcommands (cmd/server).
const (
	EvaluateChildCommand = "evaluate-child"
	ValidateChildCommand = "validate-child"
	// LintChildCommand is the public API's OTTL lint (D25 Task 3).
	LintChildCommand = "lint-child"
)

// childEnvironment is a child's whole environment: its memory limit, and
// GOMAXPROCS=2 so that each child (a whole Go runtime) starts few threads
// (the controller's Ruling 33: compose's pids_limit counts threads, serve's
// and every child's together).
var childEnvironment = []string{"GOMEMLIMIT=640MiB", "GOMAXPROCS=2"}

const (
	// maxChildLineBytes bounds one line a child writes (a result is at most
	// a few tens of KiB).
	maxChildLineBytes = 1 << 20
	// maxChildStderrBytes is how much of a child's stderr is kept, only to
	// tell a Go runtime's out-of-memory death from another; it is never
	// logged (a panic could quote a rule).
	maxChildStderrBytes = 4 << 10
	// childWaitDelay bounds the wait for a killed child's pipes to close.
	childWaitDelay = 5 * time.Second
)

// childEnd says how a child ended.
type childEnd int

const (
	// childExited: the child exited on its own; exitCode says how.
	childExited childEnd = iota
	// childAtLimit: the server killed it at its limit.
	childAtLimit
	// childOutOfMemory: something else killed it with SIGKILL (the
	// kernel's OOM killer), or the Go runtime died out of memory.
	childOutOfMemory
	// childStopped: its request or the server ended, and the server killed
	// it.
	childStopped
	// childFailed: anything else (another signal, an unreadable line).
	childFailed
)

type childOutcome struct {
	end      childEnd
	exitCode int
	lines    [][]byte
}

// childRunner starts children.
type childRunner struct {
	// command is the binary and any arguments before the subcommand.
	command []string
	// afterFunc runs f after d unless stopped (time.AfterFunc; tests fire
	// it themselves).
	afterFunc func(d time.Duration, f func()) (stop func() bool)
	// started, when set, is told each child's subcommand and pid (tests).
	started func(subcommand string, pid int)
}

// run starts subcommand with stdin, reads its lines (at most maxLines),
// and ends it at limit.
func (c *childRunner) run(ctx context.Context, subcommand string, stdin io.Reader, limit time.Duration, maxLines int) childOutcome {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var atLimit atomic.Bool
	stop := c.afterFunc(limit, func() {
		atLimit.Store(true)
		cancel()
	})
	defer stop()

	args := append(append([]string(nil), c.command[1:]...), subcommand)
	cmd := exec.CommandContext(runCtx, c.command[0], args...)
	cmd.Env = childEnvironment
	cmd.Dir = "/"
	cmd.SysProcAttr = childProcAttr()
	cmd.Cancel = func() error {
		// The whole group: the child is its leader.
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = childWaitDelay
	cmd.Stdin = stdin
	stderr := &cappedBuffer{limit: maxChildStderrBytes}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return childOutcome{end: childFailed}
	}
	if err := cmd.Start(); err != nil {
		return childOutcome{end: childFailed}
	}
	if c.started != nil {
		c.started(subcommand, cmd.Process.Pid)
	}

	lines, readErr := readLines(stdout, maxLines)
	if readErr != nil {
		// A line too long or too many: end it now.
		cancel()
		_, _ = io.Copy(io.Discard, stdout)
	}
	_ = cmd.Wait()

	outcome := childOutcome{lines: lines}
	state := cmd.ProcessState
	status, _ := state.Sys().(syscall.WaitStatus)
	switch {
	case state.Exited() && readErr == nil:
		outcome.end, outcome.exitCode = childExited, state.ExitCode()
		if outcome.exitCode == 2 && outOfMemory(stderr.Bytes()) {
			outcome.end = childOutOfMemory
		}
	case status.Signaled() && status.Signal() == syscall.SIGKILL && runCtx.Err() == nil:
		outcome.end = childOutOfMemory
	case status.Signaled() && atLimit.Load():
		outcome.end = childAtLimit
	case status.Signaled() && ctx.Err() != nil:
		outcome.end = childStopped
	default:
		outcome.end = childFailed
	}
	return outcome
}

// outOfMemory says whether a Go runtime's fatal error was for memory: its
// heap ("runtime: out of memory") or its stack ("stack overflow").
func outOfMemory(stderr []byte) bool {
	return bytes.Contains(stderr, []byte("fatal error: runtime: out of memory")) ||
		bytes.Contains(stderr, []byte("fatal error: stack overflow"))
}

var errChildLines = errors.New("the child wrote more than it may")

// readLines reads newline-ended lines until EOF.
func readLines(r io.Reader, maxLines int) ([][]byte, error) {
	reader := bufio.NewReaderSize(r, 64<<10)
	var lines [][]byte
	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			if len(lines) == maxLines {
				return lines, errChildLines
			}
			lines = append(lines, line)
		}
		if errors.Is(err, io.EOF) {
			return lines, nil
		}
		if err != nil {
			return lines, err
		}
	}
}

// readLine reads one line of at most maxChildLineBytes, without its
// newline. A last line with no newline is dropped: a child killed mid-line
// left it unfinished.
func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxChildLineBytes+1 {
			return nil, errChildLines
		}
		switch {
		case err == nil:
			return line[:len(line)-1], nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return nil, err
		}
	}
}

// cappedBuffer keeps the first limit bytes written to it.
type cappedBuffer struct {
	limit int
	buf   bytes.Buffer
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (b *cappedBuffer) Bytes() []byte { return b.buf.Bytes() }
