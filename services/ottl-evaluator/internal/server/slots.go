// The in-flight caps. An evaluation waits at most 5 s for one of its 4
// slots, a validation 1 s for one of its 8; then 503 evaluator_busy. The
// slot is taken before the body is read and freed only once the request's
// child is reaped.

package server

import (
	"context"
	"time"
)

type slots struct {
	free chan struct{}
}

func newSlots(n int) *slots {
	s := &slots{free: make(chan struct{}, n)}
	for range n {
		s.free <- struct{}{}
	}
	return s
}

// acquire takes a slot, waiting at most wait (through afterFunc), and
// returns its release; false when none came free in time or ctx ended.
func (s *slots) acquire(ctx context.Context, wait time.Duration, afterFunc func(time.Duration, func()) func() bool) (func(), bool) {
	release := func() { s.free <- struct{}{} }
	select {
	case <-s.free:
		return release, true
	default:
	}
	if wait <= 0 {
		return nil, false
	}
	expired := make(chan struct{})
	stop := afterFunc(wait, func() { close(expired) })
	defer stop()
	select {
	case <-s.free:
		return release, true
	case <-expired:
		return nil, false
	case <-ctx.Done():
		return nil, false
	}
}

// inUse is how many slots are taken (tests).
func (s *slots) inUse() int {
	return cap(s.free) - len(s.free)
}
