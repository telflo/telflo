// On Linux, a child dies with serve (Pdeathsig), even when serve is killed
// before it can kill its children.

//go:build linux

package server

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// serveThenDie is serveDiesChild's work: it starts a child that never ends
// (hangChild) through childRunner, prints the child's pid, and exits at once,
// as a serve killed outright would, killing nothing.
func serveThenDie() {
	self, err := os.Executable()
	if err != nil {
		os.Exit(9)
	}
	started := make(chan int, 1)
	runner := childRunner{
		command:   []string{self, hangChild},
		afterFunc: func(time.Duration, func()) func() bool { return func() bool { return true } },
		started:   func(_ string, pid int) { started <- pid },
	}
	go runner.run(context.Background(), EvaluateChildCommand, strings.NewReader(""), time.Hour, 1)
	fmt.Println(<-started)
	os.Exit(0)
}

// deadOrZombie says whether pid has exited (gone, or a zombie no one has
// reaped yet).
func deadOrZombie(pid int) bool {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	// The state follows the command's closing parenthesis.
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return len(fields) > 0 && (fields[0] == "Z" || fields[0] == "X")
}

func TestAChildDiesWithServe(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	serve := exec.Command(self, serveDiesChild)
	stdout, err := serve.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(stdout).ReadString('\n')
	_ = serve.Wait()
	child, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("serve's report: %q", line)
	}
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })

	// Pdeathsig is delivered when serve's thread ends; the child is then
	// reparented and reaped. Wait for that, bounded by the hang guard.
	deadline := time.After(hangGuard)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for !deadOrZombie(child) {
		select {
		case <-tick.C:
		case <-deadline:
			t.Fatal("the child outlived serve")
		}
	}
}
