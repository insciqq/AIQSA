package tmux

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// User options that hold session metadata, so it survives client restarts.
const (
	OptionTitle    = "@aiqsa_title"
	OptionProgram  = "@aiqsa_program"
	OptionStatus   = "@aiqsa_status"
	OptionStatusAt = "@aiqsa_status_at"
	OptionCwd      = "@aiqsa_cwd"
)

// SessionEnv is set in every session's environment to its id.
const SessionEnv = "AIQSA_CONNECT_SESSION"

// Default size of a new session before any view attaches.
const (
	DefaultCols = 120
	DefaultRows = 32
)

// HistoryLines is how much scrollback history captures (the history limit).
const HistoryLines = 50000

var (
	// ErrSessionNotFound is returned for a session that does not exist.
	ErrSessionNotFound = errors.New("session not found")
	// ErrNoServer means the tmux server is not running.
	ErrNoServer = errors.New("tmux server not running")
)

// Manager runs commands against the client's own tmux server.
type Manager struct {
	bin        string
	socket     string
	configPath string
}

// Options configure a Manager.
type Options struct {
	// Binary is the tmux path; empty finds it with FindBinary.
	Binary string
	// Socket is the -L socket name.
	Socket string
	// ConfigPath is the generated config file (-f).
	ConfigPath string
}

// New finds tmux, checks its version and returns a Manager.
func New(opts Options) (*Manager, error) {
	bin := opts.Binary
	if bin == "" {
		found, err := FindBinary()
		if err != nil {
			return nil, err
		}
		bin = found
	}
	if err := CheckVersion(bin); err != nil {
		return nil, err
	}
	if opts.Socket == "" || opts.ConfigPath == "" {
		return nil, errors.New("tmux socket and config path are required")
	}
	return &Manager{bin: bin, socket: opts.Socket, configPath: opts.ConfigPath}, nil
}

// Binary is the tmux executable.
func (m *Manager) Binary() string { return m.bin }

// Socket is the -L socket name.
func (m *Manager) Socket() string { return m.socket }

// ConfigPath is the generated config file.
func (m *Manager) ConfigPath() string { return m.configPath }

// baseArgs are the arguments every invocation starts with.
func (m *Manager) baseArgs() []string {
	return []string{"-u", "-L", m.socket, "-f", m.configPath}
}

// AttachCommand is the command a view runs in its PTY.
func (m *Manager) AttachCommand(id string) *exec.Cmd {
	cmd := exec.Command(m.bin, append(m.baseArgs(), "attach-session", "-t", "="+id)...)
	env := Environ()
	filtered := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "TERM=") {
			filtered = append(filtered, kv)
		}
	}
	cmd.Env = append(filtered, "TERM=xterm-256color")
	return cmd
}

// Environ is the process environment without the variables that make tmux
// think it runs nested inside another tmux.
func Environ() []string {
	env := os.Environ()
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "TMUX=") || strings.HasPrefix(kv, "TMUX_PANE=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// Arg escapes a value for tmux's argument parser: an argument ending in
// ";" separates commands unless the semicolon is escaped.
func Arg(value string) string {
	if strings.HasSuffix(value, ";") {
		return value[:len(value)-1] + `\;`
	}
	return value
}

func sessionTarget(id string) string { return "=" + id }
func paneTarget(id string) string    { return "=" + id + ":" }

// run executes one tmux command line (possibly several commands joined by
// ";" arguments) and returns stdout.
func (m *Manager) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, m.bin, append(m.baseArgs(), args...)...)
	cmd.Env = Environ()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	message := stderr.String()
	switch {
	case strings.Contains(message, "no server running"), strings.Contains(message, "error connecting to"):
		return nil, ErrNoServer
	case strings.Contains(message, "can't find session"), strings.Contains(message, "no such session"),
		strings.Contains(message, "can't find pane"), strings.Contains(message, "can't find window"),
		strings.Contains(message, "session not found"):
		return nil, ErrSessionNotFound
	}
	return nil, &CommandError{Err: err}
}

// CommandError is a failed tmux command; its stderr is deliberately not kept
// because it can quote session content.
type CommandError struct{ Err error }

func (e *CommandError) Error() string   { return "tmux command failed: " + e.Err.Error() }
func (e *CommandError) Unwrap() error   { return e.Err }
func (e *CommandError) LogCode() string { return "tmux_failed" }

// WriteConfig writes the generated config atomically and, when the server
// is already running (from an earlier client), sources it so the options
// apply without restarting the sessions.
func (m *Manager) WriteConfig(ctx context.Context, opts ConfigOptions) error {
	if err := config.WriteFileAtomic(m.configPath, []byte(ConfigText(opts)), 0o600); err != nil {
		return err
	}
	if _, err := m.run(ctx, "source-file", Arg(m.configPath)); err != nil && !errors.Is(err, ErrNoServer) {
		return err
	}
	return nil
}

// NewSessionID returns "ac-" and 8 random characters of [a-z0-9].
func NewSessionID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	id := []byte("ac-")
	for _, b := range raw {
		// 252 is the largest multiple of 36 below 256; retry to stay uniform.
		for b >= 252 {
			var one [1]byte
			if _, err := rand.Read(one[:]); err != nil {
				panic(err)
			}
			b = one[0]
		}
		id = append(id, alphabet[int(b)%len(alphabet)])
	}
	return string(id)
}

// CreateOptions describe a new session; Cwd must be an existing absolute directory.
type CreateOptions struct {
	Program protocol.Program
	Cwd     string
	Title   string
	Cols    int
	Rows    int
	Now     time.Time
}

// Create starts a detached session running the login shell and, for an
// agent, types the agent's command into it.
func (m *Manager) Create(ctx context.Context, opts CreateOptions) (string, error) {
	id := NewSessionID()
	cols, rows := opts.Cols, opts.Rows
	if cols == 0 {
		cols = DefaultCols
	}
	if rows == 0 {
		rows = DefaultRows
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	args := []string{
		"new-session", "-d", "-s", id, "-c", Arg(opts.Cwd), "-e", SessionEnv + "=" + id,
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows),
	}
	set := func(option, value string) {
		args = append(args, ";", "set-option", "-t", paneTarget(id), "--", option, Arg(value))
	}
	set(OptionTitle, opts.Title)
	set(OptionProgram, string(opts.Program))
	set(OptionStatus, string(protocol.StatusIdle))
	set(OptionStatusAt, protocol.FormatTimestamp(now))
	set(OptionCwd, opts.Cwd)
	switch opts.Program {
	case protocol.ProgramClaude, protocol.ProgramCodex:
		args = append(args, ";", "send-keys", "-t", paneTarget(id), "-l", string(opts.Program),
			";", "send-keys", "-t", paneTarget(id), "Enter")
	}
	if _, err := m.run(ctx, args...); err != nil {
		m.Kill(context.WithoutCancel(ctx), id)
		return "", err
	}
	return id, nil
}

// Session is one of the client's sessions as tmux reports it. Text fields
// are raw and must be sanitized before they leave the computer.
type Session struct {
	ID          string
	Created     time.Time
	Attached    int
	PaneCwd     string
	Title       string
	Program     string
	Status      string
	StatusAt    string
	CreationCwd string
}

var listFields = []string{
	"#{session_name}", "#{session_created}", "#{session_attached}", "#{" + OptionTitle + "}",
	"#{" + OptionProgram + "}", "#{" + OptionStatus + "}", "#{" + OptionStatusAt + "}",
	"#{" + OptionCwd + "}", "#{pane_current_path}",
}

// List returns the sessions named ac-…; no server means no sessions.
func (m *Manager) List(ctx context.Context) ([]Session, error) {
	// A random separator cannot occur in the fields, whatever a path or a
	// foreign session name contains.
	var nonce [8]byte
	rand.Read(nonce[:])
	sep := "|" + hex.EncodeToString(nonce[:]) + "|"
	end := sep + "end"
	out, err := m.run(ctx, "list-sessions", "-F", strings.Join(listFields, sep)+end)
	if errors.Is(err, ErrNoServer) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sessions []Session
	for _, record := range strings.Split(string(out), end+"\n") {
		fields := strings.Split(record, sep)
		if len(fields) != len(listFields) || !protocol.SessionIDRegexp.MatchString(fields[0]) {
			continue
		}
		created, _ := strconv.ParseInt(fields[1], 10, 64)
		attached, _ := strconv.Atoi(fields[2])
		sessions = append(sessions, Session{
			ID:          fields[0],
			Created:     time.Unix(created, 0),
			Attached:    attached,
			Title:       fields[3],
			Program:     fields[4],
			Status:      fields[5],
			StatusAt:    fields[6],
			CreationCwd: fields[7],
			PaneCwd:     fields[8],
		})
	}
	return sessions, nil
}

// Exists reports whether the session exists.
func (m *Manager) Exists(ctx context.Context, id string) (bool, error) {
	_, err := m.run(ctx, "has-session", "-t", sessionTarget(id))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrNoServer) || errors.Is(err, ErrSessionNotFound) {
		return false, nil
	}
	return false, err
}

// Kill ends a session.
func (m *Manager) Kill(ctx context.Context, id string) error {
	_, err := m.run(ctx, "kill-session", "-t", sessionTarget(id))
	if errors.Is(err, ErrNoServer) {
		return ErrSessionNotFound
	}
	return err
}

// SetOptions sets user options on a session in one tmux call.
func (m *Manager) SetOptions(ctx context.Context, id string, kv ...string) error {
	var args []string
	for i := 0; i+1 < len(kv); i += 2 {
		if len(args) > 0 {
			args = append(args, ";")
		}
		args = append(args, "set-option", "-t", paneTarget(id), "--", kv[i], Arg(kv[i+1]))
	}
	_, err := m.run(ctx, args...)
	if errors.Is(err, ErrNoServer) {
		return ErrSessionNotFound
	}
	return err
}

// Option reads one session option; empty when unset.
func (m *Manager) Option(ctx context.Context, id, option string) (string, error) {
	if exists, err := m.Exists(ctx, id); err != nil || !exists {
		if err == nil {
			err = ErrSessionNotFound
		}
		return "", err
	}
	out, err := m.run(ctx, "show-options", "-v", "-q", "-t", paneTarget(id), "--", option)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(string(out), "\n"), nil
}

// Display expands a format for a session, for example #{window_width}.
func (m *Manager) Display(ctx context.Context, id, format string) (string, error) {
	out, err := m.run(ctx, "display-message", "-p", "-t", paneTarget(id), "--", format)
	if errors.Is(err, ErrNoServer) {
		return "", ErrSessionNotFound
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(string(out), "\n"), nil
}

// CaptureScreen returns the visible screen as plain text (no escapes),
// wrapped lines joined.
func (m *Manager) CaptureScreen(ctx context.Context, id string) (string, error) {
	return m.capture(ctx, id)
}

// CaptureHistory returns the scrollback and the screen as plain text.
func (m *Manager) CaptureHistory(ctx context.Context, id string) (string, error) {
	return m.capture(ctx, id, "-S", "-"+strconv.Itoa(HistoryLines))
}

func (m *Manager) capture(ctx context.Context, id string, extra ...string) (string, error) {
	args := append([]string{"capture-pane", "-p", "-J"}, extra...)
	args = append(args, "-t", paneTarget(id))
	out, err := m.run(ctx, args...)
	if errors.Is(err, ErrNoServer) {
		return "", ErrSessionNotFound
	}
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ResolveCwd expands "~" and "~/…" against home and requires an existing
// directory. The result is a clean absolute path.
func ResolveCwd(requested, home string) (string, error) {
	path := requested
	switch {
	case path == "~":
		path = home
	case strings.HasPrefix(path, "~/"):
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("not an absolute directory")
	}
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("not an existing directory")
	}
	return path, nil
}
