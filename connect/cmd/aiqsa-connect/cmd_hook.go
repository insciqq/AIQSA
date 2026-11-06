package main

import (
	"io"
	"time"
)

func init() {
	register(command{
		name:    "hook",
		usage:   "hook",
		summary: "Internal: does nothing (kept for hooks an earlier version added)",
		run:     runHook,
	})
}

// drainWait bounds how long hook reads input it does not need, so the
// agent never sees a broken pipe while writing it.
const drainWait = 500 * time.Millisecond

// runHook ignores its arguments and input and exits 0 without output.
// Earlier versions added `aiqsa-connect hook claude|codex` to the Claude
// Code and Codex hook files; until `setup --remove` takes them out, those
// agents still run it, and a synchronous SessionEnd hook must not fail.
func runHook(inv *invocation) int {
	drained := make(chan struct{})
	go func() {
		io.Copy(io.Discard, inv.stdin)
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(drainWait):
	}
	return 0
}
