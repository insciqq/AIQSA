// Package localsock is the unix socket on which `aiqsa-connect up` hears
// agent hooks and terminal bells of its sessions. A message is one JSON
// line {"session","thread","candidate","status","reason","at","clock"}; it
// carries nothing else.
//
// A message with a session applies to it and binds its thread, if any, to
// it, moving an existing binding. A message with only a thread applies to
// the session the thread is bound to; while the thread is not bound, to its
// candidate (a session whose screen showed the thread's prompt), which it
// then binds, and with no candidate it is held for a moment, until a
// message binds the thread. A candidate never moves a binding. A report of
// a thread's ended session (idle) drops its binding.
package localsock

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/monoclock"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// SendTimeout bounds a hook's whole exchange with the daemon.
const SendTimeout = 2 * time.Second

const (
	// maxLineBytes bounds one message; a valid one is far shorter.
	maxLineBytes = 512
	// maxLinesPerConn and maxConns bound what one sender can make the daemon do.
	maxLinesPerConn = 8
	maxConns        = 16
	readTimeout     = 2 * time.Second
	// unboundLogEvery bounds how often reports of unbound threads are logged.
	unboundLogEvery = time.Minute
)

// Message is one status report.
type Message struct {
	// Session is empty when the hook could not tell its session; Thread
	// then names the agent thread whose binding decides.
	Session string `json:"session,omitempty"`
	// Thread is the agent's own session id (a Codex thread), or empty.
	Thread string `json:"thread,omitempty"`
	// Candidate is, in a message of a thread without a session, the one
	// session whose screen showed the thread's submitted prompt: it binds
	// the thread only while the thread is not bound.
	Candidate string `json:"candidate,omitempty"`
	// Weak marks a Candidate found by a short prompt line ("hi", "yes"),
	// which other conversations type too: it binds only a session no other
	// thread is bound to.
	Weak   bool                   `json:"weak,omitempty"`
	Status protocol.SessionStatus `json:"status"`
	Reason protocol.StatusReason  `json:"reason,omitempty"`
	// At is when the hook started, in nanoseconds of Clock; the daemon
	// drops a report that started before one of the same clock it already
	// applied to the session or the thread. Without it (and Clock) the
	// report is applied in arrival order.
	At int64 `json:"at,omitempty"`
	// Clock names the clock of At (monoclock.Mono or monoclock.Wall). A
	// hook of a version before it sends At alone, in Unix nanoseconds.
	Clock monoclock.Kind `json:"clock,omitempty"`
}

// Started is the hook's start stamp; invalid when the message has none.
func (m Message) Started() monoclock.Stamp {
	if m.Clock == "" && m.At > 0 {
		// A hook of the previous version, during an update's swap.
		return monoclock.Stamp{Kind: monoclock.Wall, At: m.At}
	}
	return monoclock.Stamp{Kind: m.Clock, At: m.At}
}

// Validate checks the session, thread and candidate ids, the status values
// and the start stamp, which is either absent or a valid stamp. A message
// names a session, a thread or both; a candidate only with a thread and
// without a session, and Weak only with a candidate; a bell always names
// its session and nothing else.
func (m Message) Validate() error {
	if m.Session != "" && !protocol.SessionIDRegexp.MatchString(m.Session) ||
		m.Thread != "" && !status.ValidThread(m.Thread) || m.Session == "" && m.Thread == "" ||
		m.Candidate != "" && (m.Thread == "" || m.Session != "" || !protocol.SessionIDRegexp.MatchString(m.Candidate)) ||
		m.Weak && m.Candidate == "" ||
		m.Reason == protocol.ReasonBell && (m.Session == "" || m.Thread != "") ||
		!slices.Contains(protocol.SessionStatuses, m.Status) ||
		m.Reason != "" && !slices.Contains(protocol.StatusReasons, m.Reason) ||
		(m.At != 0 || m.Clock != "") && !m.Started().Valid() {
		return errors.New("invalid status message")
	}
	return nil
}

// Path is where the daemon of these paths listens. A client run with its
// own state directory (AIQSA_CONNECT_STATE_DIR) keeps the socket there, so
// isolated clients never share one; otherwise it is
// $XDG_RUNTIME_DIR/<tmux socket name>.sock ("aiqsa-connect.sock" by
// default) when that directory is private to the user, else daemon.sock in
// the state directory.
func Path(paths config.Paths) string {
	if os.Getenv(config.EnvStateDir) == "" {
		if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" && filepath.IsAbs(dir) {
			if info, err := os.Stat(dir); err == nil && info.IsDir() && private(info) {
				return filepath.Join(dir, paths.TmuxSocket+".sock")
			}
		}
	}
	return filepath.Join(paths.StateDir, "daemon.sock")
}

// private reports whether a directory belongs to this user alone.
func private(info os.FileInfo) bool {
	if info.Mode().Perm()&0o077 != 0 {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return !ok || int(st.Uid) == os.Getuid()
}

// Candidates are the sockets of these paths: Path, then the state
// directory's socket. The daemon listens on all of them and a hook tries
// them in order, so the two meet even when a session's environment lacks
// the runtime directory the daemon saw, or has one it did not (the tmux
// server keeps the environment of whichever `up` started it).
func Candidates(paths config.Paths) []string {
	primary := Path(paths)
	fallback := filepath.Join(paths.StateDir, "daemon.sock")
	if primary == fallback {
		return []string{primary}
	}
	return []string{primary, fallback}
}

// Reporter applies a status; *daemon.Daemon is one. It returns
// tmux.ErrSessionNotFound for a session that is gone.
type Reporter interface {
	ReportStatus(sessionID string, status protocol.SessionStatus, reason protocol.StatusReason) error
}

// Server listens on its sockets until its context ends.
type Server struct {
	listeners []*net.UnixListener
	reporter  Reporter
	log       *logx.Logger
	gate      *status.Gate
	threads   *threads
	// applyMu makes the order check and the report one step per message.
	applyMu sync.Mutex
	// unboundLogged is when hook_thread_unbound was last logged (applyMu).
	unboundLogged time.Time
	slots         chan struct{}
	wg            sync.WaitGroup
}

// Listen creates a socket with mode 0600 at each of paths (duplicates
// once). A socket file left by a process that is gone is removed first; a
// live one means another daemon and is an error. Any other file at a path
// is never touched. On an error no socket stays open. gate is
// status.NewGate(nil) when nil.
func Listen(paths []string, reporter Reporter, log *logx.Logger, gate *status.Gate) (*Server, error) {
	if gate == nil {
		gate = status.NewGate(nil)
	}
	if len(paths) == 0 {
		return nil, errors.New("cannot listen for agent hooks: no socket path")
	}
	s := &Server{reporter: reporter, log: log, gate: gate, threads: newThreads(), slots: make(chan struct{}, maxConns)}
	for i, path := range paths {
		if slices.Contains(paths[:i], path) {
			continue
		}
		listener, err := listenOne(path)
		if err != nil {
			s.Close()
			return nil, err
		}
		s.listeners = append(s.listeners, listener)
	}
	return s, nil
}

func listenOne(path string) (*net.UnixListener, error) {
	if err := removeStale(path); err != nil {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("cannot listen for agent hooks: %w", err)
	}
	// The directory is private (0700), so the moment before chmod exposes nothing.
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, fmt.Errorf("cannot listen for agent hooks: %w", err)
	}
	return listener, nil
}

func removeStale(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode().Type() != os.ModeSocket {
		return fmt.Errorf("cannot listen for agent hooks: %s exists and is not a socket", path)
	}
	if conn, err := net.DialTimeout("unix", path, 500*time.Millisecond); err == nil {
		conn.Close()
		return errors.New("cannot listen for agent hooks: another aiqsa-connect up is already listening")
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot remove the stale hook socket: %w", err)
	}
	return nil
}

// Serve accepts connections until ctx ends, then closes the sockets (which
// removes their files) and waits for open connections.
func (s *Server) Serve(ctx context.Context) {
	stop := context.AfterFunc(ctx, func() { s.Close() })
	defer stop()
	var accepting sync.WaitGroup
	for _, listener := range s.listeners {
		accepting.Go(func() { s.accept(ctx, listener) })
	}
	accepting.Wait()
	s.Close()
	s.wg.Wait()
}

func (s *Server) accept(ctx context.Context, listener *net.UnixListener) {
	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			s.log.Event("hook_socket_accept_failed", "err", err)
			select {
			case <-ctx.Done():
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		select {
		case s.slots <- struct{}{}:
		default:
			// Busy: the hook gives up after its timeout and the agent goes on.
			s.log.Event("hook_socket_busy")
			conn.Close()
			continue
		}
		s.wg.Go(func() {
			defer func() { <-s.slots }()
			s.handle(conn)
		})
	}
}

// Close stops listening; Serve returns once open connections end.
func (s *Server) Close() error {
	var errs []error
	for _, listener := range s.listeners {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Server) handle(conn *net.UnixConn) {
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(readTimeout))
	reader := bufio.NewReaderSize(conn, maxLineBytes)
	for range maxLinesPerConn {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			s.log.Event("hook_message_rejected", "cause", "too_large")
			return
		}
		if len(bytes.TrimSpace(line)) > 0 {
			s.apply(line)
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) apply(line []byte) {
	var msg Message
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&msg); err != nil || msg.Validate() != nil {
		s.log.Event("hook_message_rejected", "cause", "invalid")
		return
	}
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	s.deliver(msg)
}

// deliver applies one valid message (applyMu).
func (s *Server) deliver(msg Message) {
	if msg.Reason == protocol.ReasonBell {
		if !s.gate.AcceptBell(msg.Session) {
			s.log.Event("bell_ignored")
			return
		}
		s.report(msg.Session, msg)
		return
	}
	if msg.Thread == "" {
		if !s.gate.AcceptHook(msg.Session, msg.Started()) {
			s.log.Event("hook_status_stale")
			return
		}
		s.report(msg.Session, msg)
		return
	}
	session, bound := s.threads.session(msg.Thread)
	switch {
	case msg.Session != "":
		// The hook found its session for sure: it binds, or moves, the thread.
		session = msg.Session
	case bound:
		// A prompt also shown on another session's screen never moves a binding.
	case msg.Candidate != "" && !(msg.Weak && s.threads.taken(msg.Candidate)):
		// A short prompt line never takes a session another thread holds.
		session = msg.Candidate
	default:
		// A thread of an agent outside the client's sessions, or one whose
		// prompt has not bound it yet. Every Codex thread on the computer
		// runs the hook: the log notes it rarely.
		s.threads.hold(msg)
		if now := time.Now(); now.Sub(s.unboundLogged) >= unboundLogEvery {
			s.unboundLogged = now
			s.log.Event("hook_thread_unbound")
		}
		return
	}
	// A stale report changes neither the status nor the binding.
	if !s.gate.AcceptThreadHook(session, msg.Thread, msg.Started()) {
		s.log.Event("hook_status_stale")
		return
	}
	ended := msg.Status == protocol.StatusIdle
	if ended {
		// The agent session ended: its thread, resumed anywhere, is a new
		// one to bind. The gate keeps the thread's order, so an earlier hook
		// arriving late binds it to nothing.
		s.threads.unbind(msg.Thread)
	} else {
		s.threads.bind(msg.Thread, session)
	}
	s.report(session, msg)
	if !ended {
		// Events whose hooks reached the daemon before the binding prompt's.
		for _, held := range s.threads.take(msg.Thread) {
			s.deliver(held)
		}
	}
}

func (s *Server) report(session string, msg Message) {
	if err := s.reporter.ReportStatus(session, msg.Status, msg.Reason); err != nil {
		if errors.Is(err, tmux.ErrSessionNotFound) {
			s.threads.forgetSession(session)
		}
		s.log.Event("hook_status_failed", "err", err)
	}
}

// Send delivers one message to the first of paths that accepts a
// connection, within SendTimeout or ctx, whichever ends first.
func Send(ctx context.Context, paths []string, msg Message) error {
	if err := msg.Validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, SendTimeout)
	defer cancel()
	var dialer net.Dialer
	var conn net.Conn
	err := errors.New("no hook socket")
	for _, path := range paths {
		if conn, err = dialer.DialContext(ctx, "unix", path); err == nil || ctx.Err() != nil {
			break
		}
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	conn.SetDeadline(deadline)
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = conn.Write(append(data, '\n'))
	return err
}
