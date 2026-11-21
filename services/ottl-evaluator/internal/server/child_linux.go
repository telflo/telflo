// On Linux a child also gets SIGKILL when serve dies (Pdeathsig), so a serve
// killed without its shutdown (an OOM kill, a `docker kill`) never leaves a
// child running. Pdeathsig follows the thread that started the child; Go
// ends a thread only when a goroutine locked to it exits, and nothing here
// locks one.

//go:build linux

package server

import "syscall"

// childProcAttr puts a child in its own process group (the group is what
// is killed) and asks for SIGKILL when its parent dies.
func childProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
