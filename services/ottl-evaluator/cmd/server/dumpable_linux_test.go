// serve makes the process non-dumpable, and the tests run in one process:
// a test that runs serve makes it dumpable again when it ends. A
// non-dumpable process's /proc/self files belong to root, so a later test
// that runs a child's command in this process couldn't raise its
// oom_score_adj (rules.ExitSetup) unless it runs as root.

//go:build linux

package main

import (
	"syscall"
	"testing"
)

// dumpableAgainAfter makes the process dumpable again when t ends.
func dumpableAgainAfter(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 1, 0); errno != 0 {
			t.Fatalf("PR_SET_DUMPABLE 1: %v", errno)
		}
	})
}
