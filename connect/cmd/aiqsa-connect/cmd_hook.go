package main

import (
	"context"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/localsock"
	"github.com/insciqq/AIQSA/connect/internal/procs"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// sessionEnv names the session a process runs in; tmux sets it for every
// session the client creates.
const sessionEnv = "AIQSA_CONNECT_SESSION"

func init() {
	register(command{
		name:    "hook",
		usage:   "hook claude|codex|bell [session]",
		summary: "Internal: report an agent's status to aiqsa-connect up",
		run:     runHook,
	})
	upHooks = append(upHooks, serveHookSocket)
}

// drainWait bounds how long a hook keeps reading input it does not need, so
// the agent never sees a broken pipe while writing it.
const drainWait = 500 * time.Millisecond

// runHook reports one status and always exits 0 without output: agents run
// it from their hooks, and nothing it does may change what they do.
func runHook(inv *invocation) int {
	// The agent starts its hooks in event order; the daemon orders reports by it.
	started := time.Now()
	if len(inv.args) == 0 || len(inv.args) > 2 {
		return 0
	}
	var session string
	var update status.Update
	switch agent := status.Agent(inv.args[0]); agent {
	case status.AgentClaude, status.AgentCodex:
		session = os.Getenv(sessionEnv)
		if session != "" && !protocol.SessionIDRegexp.MatchString(session) {
			return 0
		}
		in := status.ReadHookInput(inv.stdin)
		drained := make(chan struct{})
		go func() {
			io.Copy(io.Discard, inv.stdin)
			close(drained)
		}()
		defer func() {
			select {
			case <-drained:
			case <-time.After(drainWait):
			}
		}()
		var ok bool
		if update, ok = status.FromHook(agent, in); !ok {
			return 0
		}
		if session == "" {
			// Codex runs its hooks with a scrubbed environment.
			if session = sessionOfAncestry(inv.ctx); session == "" {
				return 0
			}
		}
	case "bell":
		if len(inv.args) != 2 || !protocol.SessionIDRegexp.MatchString(inv.args[1]) {
			return 0
		}
		session = inv.args[1]
		update = status.Bell()
	default:
		return 0
	}
	paths, err := hookPaths()
	if err != nil {
		return 0
	}
	// The daemon may be down; the agent goes on either way.
	localsock.Send(inv.ctx, localsock.Candidates(paths), localsock.Message{
		Session: session, Status: update.Status, Reason: update.Reason, At: started.UnixNano(),
	})
	return 0
}

// hookPaths are the client's paths as a hook sees them. An agent may run
// its hooks without HOME; the user's account still names the home, and the
// daemon of a client with default directories listens in it.
func hookPaths() (config.Paths, error) {
	paths, err := config.ResolvePaths()
	if err == nil || os.Getenv("HOME") != "" {
		return paths, err
	}
	u, userErr := user.Current()
	if userErr != nil || !filepath.IsAbs(u.HomeDir) {
		return paths, err
	}
	// The hook is a process of its own; only it and its children see this.
	os.Setenv("HOME", u.HomeDir)
	return config.ResolvePaths()
}

// ancestryWait bounds the search for a hook's session in the process tree.
const ancestryWait = time.Second

// sessionOfAncestry finds the session of a hook whose environment lacks
// AIQSA_CONNECT_SESSION: the session of the nearest ancestor process that
// is a pane of the client's own tmux server. Panes of any other tmux
// server never count. Empty when there is none.
func sessionOfAncestry(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, ancestryWait)
	defer cancel()
	paths, err := hookPaths()
	if err != nil {
		return ""
	}
	bin, err := tmux.FindBinary()
	if err != nil {
		return ""
	}
	panes, err := tmux.PaneSessions(ctx, bin, paths.TmuxSocket)
	if err != nil || len(panes) == 0 {
		return ""
	}
	return sessionOfAncestors(procs.System(ctx), os.Getppid(), panes)
}

// sessionOfAncestors returns the session of the nearest of pid and its
// ancestors that is a pane in panes (pane pid -> session name) of one of
// the client's sessions.
func sessionOfAncestors(table procs.Table, pid int, panes map[int]string) string {
	ours := func(pid int) bool {
		name, ok := panes[pid]
		return ok && protocol.SessionIDRegexp.MatchString(name)
	}
	if pane, ok := procs.FindAncestor(table, pid, ours); ok {
		return panes[pane]
	}
	return ""
}

// serveHookSocket runs the local socket for as long as `up` runs.
func serveHookSocket(ctx context.Context, d *daemon.Daemon) error {
	paths, err := config.ResolvePaths()
	if err != nil {
		return err
	}
	// `up` has created the private state directory; the runtime directory
	// is the user's own (0700) by definition. Both sockets are served: the
	// sessions' environment comes from whichever `up` started tmux.
	server, err := localsock.Listen(localsock.Candidates(paths), d, d.Log(), nil)
	if err != nil {
		return err
	}
	go server.Serve(ctx)
	return nil
}
