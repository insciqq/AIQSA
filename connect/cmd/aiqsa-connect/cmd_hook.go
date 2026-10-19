package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/localsock"
	"github.com/insciqq/AIQSA/connect/internal/monoclock"
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
//
// A Codex hook also reports its Codex thread (the input's session_id).
// When it finds its session from the environment or its pane ancestry, the
// daemon binds the thread to that session. For a submitted prompt the one
// Codex session whose screen shows it is only a candidate: the daemon binds
// the thread to it while the thread is not bound. Otherwise the daemon
// applies the report to the session the thread is bound to, or holds it
// for a moment until the thread is bound. A Codex thread elsewhere in the
// same folder (another terminal, another tmux server) is not bound unless
// its prompt shows on such a screen, so it does not change a session's
// status.
func runHook(inv *invocation) int {
	// The agent starts its hooks in event order; the daemon orders reports
	// by it. The wall clock can step back between two hooks (WSL's time
	// sync does, by up to a second), so a monotonic clock stamps it.
	started := monoclock.Now()
	if len(inv.args) == 0 || len(inv.args) > 2 {
		return 0
	}
	var session, thread, candidate string
	var weak bool
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
		if agent == status.AgentCodex {
			thread = in.Thread
		}
		if session == "" {
			// Codex runs its hooks with a scrubbed environment, possibly
			// from a background process outside the session's pane.
			session, candidate = sessionOfHook(inv.ctx, agent, in)
			if thread == "" {
				candidate = ""
			}
			weak = candidate != "" && status.ShortPromptKey(in.PromptKey)
			if session == "" && thread == "" {
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
		Session: session, Thread: thread, Candidate: candidate, Weak: weak,
		Status: update.Status, Reason: update.Reason,
		At: started.At, Clock: started.Kind,
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

// sessionSearchWait bounds the look at the client's panes: one tmux call
// and one process snapshot.
const sessionSearchWait = time.Second

// hookScene is the client's tmux server and this computer's processes as
// a hook saw them.
type hookScene struct {
	bin, socket string
	panes       []tmux.Pane
	snapshot    *procs.Snapshot
}

// lookAround lists the panes of the client's own tmux server, the only
// panes that ever count, and takes one process snapshot. Nil when there are
// none or either cannot be read.
func lookAround(ctx context.Context) *hookScene {
	ctx, cancel := context.WithTimeout(ctx, sessionSearchWait)
	defer cancel()
	paths, err := hookPaths()
	if err != nil {
		return nil
	}
	bin, err := tmux.FindBinary()
	if err != nil {
		return nil
	}
	panes, err := tmux.ListPanes(ctx, bin, paths.TmuxSocket)
	if err != nil || len(panes) == 0 {
		return nil
	}
	snapshot, err := procs.Take(ctx)
	if err != nil {
		return nil
	}
	return &hookScene{bin: bin, socket: paths.TmuxSocket, panes: panes, snapshot: snapshot}
}

// sessionOfHook finds the session of a hook whose environment lacks
// AIQSA_CONNECT_SESSION: the session of the nearest ancestor process that
// is a pane. Failing that, for a prompt a Codex user submitted, the one
// Codex session in the hook's directory whose pane runs codex and whose
// screen shows the prompt is the candidate: another session's screen may
// show the same line, so it binds only a thread that is not bound. Both
// are empty when there is none, or more than one candidate.
func sessionOfHook(ctx context.Context, agent status.Agent, in status.HookInput) (session, candidate string) {
	scene := lookAround(ctx)
	if scene == nil {
		return "", ""
	}
	sessions := make(map[int]string, len(scene.panes))
	for _, pane := range scene.panes {
		sessions[pane.PID] = pane.Session
	}
	if session := sessionOfAncestors(scene.snapshot, os.Getppid(), sessions); session != "" {
		return session, ""
	}
	if agent != status.AgentCodex || in.Event != "UserPromptSubmit" || in.Cwd == "" || in.PromptKey == "" {
		return "", ""
	}
	candidates := codexSessionsOfCwd(scene.snapshot, scene.panes, in.Cwd)
	if len(candidates) == 0 {
		return "", ""
	}
	capture := func(ctx context.Context, session string) (string, error) {
		return tmux.CapturePane(ctx, scene.bin, scene.socket, session, promptHistoryLines)
	}
	return "", sessionShowingPrompt(ctx, candidates, in.PromptKey, capture)
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

// codexSessionsOfCwd returns, once each, the client's Codex sessions whose
// pane is in cwd and still runs a process named codex. Paths compare
// cleaned and, where they resolve, with symlinks resolved.
func codexSessionsOfCwd(snapshot *procs.Snapshot, panes []tmux.Pane, cwd string) []string {
	want := canonicalPath(cwd)
	isCodex := func(name string) bool { return name == string(protocol.ProgramCodex) }
	var found []string
	for _, pane := range panes {
		if pane.Program != string(protocol.ProgramCodex) || !protocol.SessionIDRegexp.MatchString(pane.Session) ||
			!filepath.IsAbs(pane.Cwd) || slices.Contains(found, pane.Session) {
			continue
		}
		if canonicalPath(pane.Cwd) == want && snapshot.HasDescendant(pane.PID, isCodex) {
			found = append(found, pane.Session)
		}
	}
	return found
}

// canonicalPath is path cleaned, with symlinks resolved when it resolves.
func canonicalPath(path string) string {
	path = filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

// promptHistoryLines is how far above a pane's screen a submitted prompt is
// looked for: Codex may already have moved it into the scrollback.
const promptHistoryLines = 60

// promptLookAt is when, after a prompt hook starts, the candidate screens
// are read: the TUI may draw the submitted prompt after its hook started.
var promptLookAt = []time.Duration{0, 100 * time.Millisecond, 250 * time.Millisecond, 600 * time.Millisecond}

// promptSearchWait bounds the whole prompt search.
const promptSearchWait = time.Second

// sessionShowingPrompt returns the only one of candidates whose screen
// shows the prompt key, looking again a few times while none does. Empty
// when none ever does, when more than one does, or when a screen cannot be
// read. The screens are compared in memory only.
func sessionShowingPrompt(ctx context.Context, candidates []string, key string, capture func(context.Context, string) (string, error)) string {
	ctx, cancel := context.WithTimeout(ctx, promptSearchWait)
	defer cancel()
	start := time.Now()
	for _, at := range promptLookAt {
		if wait := time.Until(start.Add(at)); wait > 0 {
			select {
			case <-ctx.Done():
				return ""
			case <-time.After(wait):
			}
		}
		found := ""
		for _, session := range candidates {
			screen, err := capture(ctx, session)
			if errors.Is(err, tmux.ErrSessionNotFound) {
				continue
			}
			if err != nil {
				return ""
			}
			if !status.ScreenShows(screen, key) {
				continue
			}
			if found != "" {
				// The same prompt in two sessions: neither is chosen.
				return ""
			}
			found = session
		}
		if found != "" {
			return found
		}
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
