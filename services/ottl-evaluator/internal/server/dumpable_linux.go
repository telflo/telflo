// After the collector tester's app/hardening.py.

//go:build linux

package server

import (
	"errors"
	"syscall"
)

// makeNotDumpable sets PR_SET_DUMPABLE to 0 and checks it took, before the
// secret's file is read: another process of the same uid (an evaluation's
// child included) then gets "Permission denied" on this process's environ,
// fd, mem, maps and cwd, and can't ptrace it.
func makeNotDumpable() error {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0); errno != 0 {
		return errno
	}
	dumpable, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_GET_DUMPABLE, 0, 0)
	if errno != 0 {
		return errno
	}
	if dumpable != 0 {
		return errors.New("the process is still dumpable after prctl(PR_SET_DUMPABLE, 0)")
	}
	return nil
}
