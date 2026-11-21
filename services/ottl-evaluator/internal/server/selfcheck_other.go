// The selfcheck reads /proc and checks the Linux container: elsewhere (a
// developer's macOS) there is nothing to check, and it says so and fails.

//go:build !linux

package server

import (
	"context"
	"fmt"
	"io"
)

// Selfcheck fails outside Linux: see selfcheck_linux.go.
func Selfcheck(_ context.Context, _ func(string) string, _ []string, stdout io.Writer) int {
	fmt.Fprintln(stdout, "FAIL selfcheck: it checks the evaluator's Linux container, and this isn't Linux")
	return 1
}
