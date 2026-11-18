// New in the follow-up to D15a Task 2's review (the controller's Ruling 33).
// Pdeathsig is Linux's (child_linux.go): elsewhere (a developer's macOS) a
// child gets its own process group only.

//go:build !linux

package server

import "syscall"

// childProcAttr puts a child in its own process group (the group is what
// is killed).
func childProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
