// serveDiesChild is Linux's stand-in (child_linux_test.go); elsewhere it
// only exits.

//go:build !linux

package server

import "os"

func serveThenDie() { os.Exit(9) }
