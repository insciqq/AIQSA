package main

import (
	"fmt"
	"syscall"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "attach",
		usage:   "attach <session-id>",
		summary: "Attach this terminal to a session",
		run:     runAttach,
	})
}

// execTmux replaces the process with tmux; tests replace it.
var execTmux = syscall.Exec

func runAttach(inv *invocation) int {
	if len(inv.args) != 1 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect attach <session-id>   (see aiqsa-connect sessions)")
		return 2
	}
	id := inv.args[0]
	if !protocol.SessionIDRegexp.MatchString(id) {
		fmt.Fprintf(inv.stderr, "aiqsa-connect attach: %q is not a session id (they look like ac-1a2b3c4d)\n", id)
		return 2
	}
	manager, err := localManager()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect attach: %v\n", err)
		return 1
	}
	exists, err := manager.Exists(inv.ctx, id)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect attach: %v\n", err)
		return 1
	}
	if !exists {
		fmt.Fprintf(inv.stderr, "aiqsa-connect attach: no session %s (see aiqsa-connect sessions)\n", id)
		return 1
	}
	argv := []string{"tmux", "-u", "-L", manager.Socket(), "attach-session", "-t", "=" + id}
	if err := execTmux(manager.Binary(), argv, tmux.Environ()); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect attach: cannot start tmux: %v\n", err)
		return 1
	}
	return 0
}
