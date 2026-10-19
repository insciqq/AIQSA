package main

import (
	"context"
	"io"
	"os"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/localsock"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
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
		if session == "" || !protocol.SessionIDRegexp.MatchString(session) {
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
	case "bell":
		if len(inv.args) != 2 || !protocol.SessionIDRegexp.MatchString(inv.args[1]) {
			return 0
		}
		session = inv.args[1]
		update = status.Bell()
	default:
		return 0
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		return 0
	}
	// The daemon may be down; the agent goes on either way.
	localsock.Send(inv.ctx, localsock.Candidates(paths), localsock.Message{
		Session: session, Status: update.Status, Reason: update.Reason, At: started.UnixNano(),
	})
	return 0
}

// serveHookSocket runs the local socket for as long as `up` runs.
func serveHookSocket(ctx context.Context, d *daemon.Daemon) error {
	paths, err := config.ResolvePaths()
	if err != nil {
		return err
	}
	// `up` has created the private state directory; the runtime directory
	// is the user's own (0700) by definition.
	server, err := localsock.Listen(localsock.Path(paths), d, d.Log(), nil)
	if err != nil {
		return err
	}
	go server.Serve(ctx)
	return nil
}
