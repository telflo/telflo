// New in the follow-up to D15a Task 2's review (the controller's Ruling 33):
// the properties a child gets from childRunner, seen from inside a
// stand-in child (main_test.go's TestMain answers reportChild): its whole
// environment is the allowed set, it leads its own process group, and the
// kill at its limit takes the whole group, a grandchild included. D15a Task
// 3's follow-up (the controller's Ruling 34) registers the cleanup that kills
// the child's group before anything in the test can fail.

package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// childReport is what reportChild writes to its FIFO.
type childReport struct {
	Environ    []string `json:"environ"`
	PID        int      `json:"pid"`
	PGID       int      `json:"pgid"`
	Grandchild int      `json:"grandchild"`
}

// reportToFIFO is reportChild's work: it opens the FIFO, starts a grandchild
// (in the child's process group, as anything the child starts is) that
// holds the FIFO open too, as its stdout, and never ends, and writes its
// report. The test's read of the FIFO ends only
// when every process holding it is dead.
func reportToFIFO(fifo string) {
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		os.Exit(9)
	}
	grandchild := exec.Command(os.Args[0], hangChild)
	grandchild.Stdout = f
	if grandchild.Start() != nil {
		os.Exit(9)
	}
	pgid, _ := syscall.Getpgid(0)
	report, _ := json.Marshal(childReport{Environ: os.Environ(), PID: os.Getpid(), PGID: pgid, Grandchild: grandchild.Process.Pid})
	_, _ = f.Write(append(report, '\n'))
}

// readFIFO opens fifo and sends its first line, then whether it reached
// EOF (every writer gone), on the channels.
func readFIFO(fifo string, firstLine chan<- string, eof chan<- bool) {
	f, err := os.Open(fifo)
	if err != nil {
		firstLine <- ""
		return
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	line, _ := reader.ReadString('\n')
	firstLine <- line
	_, err = io.Copy(io.Discard, reader)
	eof <- err == nil
}

func TestAChildGetsOnlyItsEnvironmentLeadsItsGroupAndDiesWithIt(t *testing.T) {
	// Whatever fails below, neither the child nor its grandchild outlives
	// the test. The cleanup, registered before anything can fail, ends the
	// runner's context: the runner then kills the child's whole group (the
	// grandchild is in it) or, if it hasn't started the child yet, never
	// does; the cleanup waits for the runner to return. The grandchild is
	// killed by its pid too, until the test has seen it die.
	ctx, cancel := context.WithCancel(context.Background())
	var runnerStarted atomic.Bool
	runnerDone := make(chan struct{})
	var grandchildPID atomic.Int64
	t.Cleanup(func() {
		cancel()
		if runnerStarted.Load() {
			select {
			case <-runnerDone:
			case <-time.After(hangGuard):
				t.Error("the runner never returned")
			}
		}
		if pid := int(grandchildPID.Load()); pid > 0 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})

	fifo := filepath.Join(t.TempDir(), "report")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	firstLine, eof := make(chan string, 1), make(chan bool, 1)
	go readFIFO(fifo, firstLine, eof)

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	timers := newTimers()
	runner := childRunner{command: []string{self, reportChild, fifo}, afterFunc: timers.afterFunc}
	const limit = 25 * time.Second
	outcome := make(chan childOutcome, 1)
	runnerStarted.Store(true)
	go func() {
		defer close(runnerDone)
		outcome <- runner.run(ctx, EvaluateChildCommand, strings.NewReader("{}\n"), limit, 4)
	}()

	var report childReport
	select {
	case line := <-firstLine:
		if err := json.Unmarshal([]byte(line), &report); err != nil {
			t.Fatalf("the child's report: %q", line)
		}
		grandchildPID.Store(int64(report.Grandchild))
	case <-time.After(hangGuard):
		t.Fatal("the child never reported")
	}

	environ := slices.Clone(report.Environ)
	slices.Sort(environ)
	if want := []string{"GOMAXPROCS=2", "GOMEMLIMIT=640MiB"}; !slices.Equal(environ, want) {
		t.Errorf("the child's environment is %q, want exactly %q", environ, want)
	}
	if report.PGID != report.PID {
		t.Errorf("the child's process group is %d, not its own (%d)", report.PGID, report.PID)
	}

	timers.next(t, limit).fire()
	select {
	case o := <-outcome:
		if o.end != childAtLimit {
			t.Errorf("the child ended %d, want at its limit", o.end)
		}
	case <-time.After(hangGuard):
		t.Fatal("the child wasn't ended at its limit")
	}
	select {
	case gone := <-eof:
		grandchildPID.Store(0) // every writer of the FIFO is dead
		if !gone {
			t.Error("reading the FIFO failed")
		}
	case <-time.After(hangGuard):
		t.Fatal("the grandchild outlived the kill: the FIFO is still held open")
	}
}
