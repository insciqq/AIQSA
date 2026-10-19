// Package localsock is the unix socket on which `aiqsa-connect up` hears
// agent hooks and terminal bells of its sessions. A message is one JSON
// line {"session","status","reason"}; it carries nothing else.
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
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
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
)

// Message is one status report.
type Message struct {
	Session string                 `json:"session"`
	Status  protocol.SessionStatus `json:"status"`
	Reason  protocol.StatusReason  `json:"reason,omitempty"`
	// At is when the hook started, in Unix nanoseconds; the daemon drops a
	// report older than one it already applied to the session.
	At int64 `json:"at,omitempty"`
}

// Validate checks the session id and the status values.
func (m Message) Validate() error {
	if !protocol.SessionIDRegexp.MatchString(m.Session) || !slices.Contains(protocol.SessionStatuses, m.Status) ||
		m.Reason != "" && !slices.Contains(protocol.StatusReasons, m.Reason) || m.At < 0 {
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

// Candidates are the paths a hook tries, in order: Path, then the state
// directory's socket. A session's environment can lack the runtime
// directory the daemon saw (its tmux server started from another login).
func Candidates(paths config.Paths) []string {
	primary := Path(paths)
	fallback := filepath.Join(paths.StateDir, "daemon.sock")
	if primary == fallback {
		return []string{primary}
	}
	return []string{primary, fallback}
}

// Reporter applies a status; *daemon.Daemon is one.
type Reporter interface {
	ReportStatus(sessionID string, status protocol.SessionStatus, reason protocol.StatusReason) error
}

// Server listens on the socket until its context ends.
type Server struct {
	listener *net.UnixListener
	reporter Reporter
	log      *logx.Logger
	gate     *status.Gate
	// applyMu makes the order check and the report one step per message.
	applyMu sync.Mutex
	slots   chan struct{}
	wg      sync.WaitGroup
}

// Listen creates the socket at path with mode 0600. A socket file left by a
// process that is gone is removed first; a live one means another daemon
// and is an error. Any other file at path is never touched. gate is
// status.NewGate(nil) when nil.
func Listen(path string, reporter Reporter, log *logx.Logger, gate *status.Gate) (*Server, error) {
	if gate == nil {
		gate = status.NewGate(nil)
	}
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
	return &Server{listener: listener, reporter: reporter, log: log, gate: gate, slots: make(chan struct{}, maxConns)}, nil
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

// Serve accepts connections until ctx ends, then closes the socket (which
// removes its file) and waits for open connections.
func (s *Server) Serve(ctx context.Context) {
	stop := context.AfterFunc(ctx, func() { s.listener.Close() })
	defer stop()
	for {
		conn, err := s.listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				break
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
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() { <-s.slots }()
			s.handle(conn)
		}()
	}
	s.listener.Close()
	s.wg.Wait()
}

// Close stops listening; Serve returns once open connections end.
func (s *Server) Close() error { return s.listener.Close() }

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
	if msg.Reason == protocol.ReasonBell {
		if !s.gate.AcceptBell(msg.Session) {
			s.log.Event("bell_ignored")
			return
		}
	} else {
		var started time.Time
		if msg.At > 0 {
			started = time.Unix(0, msg.At)
		}
		if !s.gate.AcceptHook(msg.Session, started) {
			s.log.Event("hook_status_stale")
			return
		}
	}
	if err := s.reporter.ReportStatus(msg.Session, msg.Status, msg.Reason); err != nil {
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
