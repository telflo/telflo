// New in D15a Task 2 (plan Preflight ruling 12). PR_SET_DUMPABLE is
// Linux's: elsewhere (a developer's macOS) there is nothing to set.

//go:build !linux

package server

func makeNotDumpable() error {
	return nil
}
