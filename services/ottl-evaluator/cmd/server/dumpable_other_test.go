// PR_SET_DUMPABLE is Linux's: elsewhere serve changes nothing to restore.

//go:build !linux

package main

import "testing"

func dumpableAgainAfter(*testing.T) {}
