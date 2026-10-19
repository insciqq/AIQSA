package localsock

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/monoclock"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
)

type report struct {
	session string
	status  protocol.SessionStatus
	reason  protocol.StatusReason
}

type fakeReporter struct {
	mu      sync.Mutex
	reports []report
	got     chan struct{}
}

func newFakeReporter() *fakeReporter { return &fakeReporter{got: make(chan struct{}, 64)} }

func (f *fakeReporter) ReportStatus(session string, s protocol.SessionStatus, r protocol.StatusReason) error {
	f.mu.Lock()
	f.reports = append(f.reports, report{session, s, r})
	f.mu.Unlock()
	f.got <- struct{}{}
	return nil
}

func (f *fakeReporter) list() []report {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]report(nil), f.reports...)
}

func (f *fakeReporter) wait(t *testing.T, n int) []report {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for len(f.list()) < n {
		select {
		case <-f.got:
		case <-deadline:
			t.Fatalf("got %d reports, want %d", len(f.list()), n)
		}
	}
	return f.list()
}

// shortDir is a private directory with a path short enough for a socket.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "acs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

type served struct {
	path     string
	reporter *fakeReporter
	log      *bytes.Buffer
	logMu    *sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
}

type lockedBuffer struct {
	mu  *sync.Mutex
	buf *bytes.Buffer
}

func (w lockedBuffer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func serve(t *testing.T, gate *status.Gate) *served {
	t.Helper()
	s := &served{path: filepath.Join(shortDir(t), "daemon.sock"), reporter: newFakeReporter(), log: &bytes.Buffer{}, logMu: &sync.Mutex{}, done: make(chan struct{})}
	server, err := Listen([]string{s.path}, s.reporter, logx.New(lockedBuffer{s.logMu, s.log}), gate)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go func() {
		server.Serve(ctx)
		close(s.done)
	}()
	t.Cleanup(func() {
		cancel()
		<-s.done
	})
	return s
}

func (s *served) logText() string {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	return s.log.String()
}

func TestSendReachesTheDaemonOnAPrivateSocket(t *testing.T) {
	s := serve(t, nil)
	info, err := os.Lstat(s.path)
	if err != nil || info.Mode().Type() != os.ModeSocket || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket: %v %v", info, err)
	}
	if err := Send(context.Background(), []string{s.path}, Message{Session: "ac-abc123", Status: protocol.StatusNeedsApproval, Reason: protocol.ReasonPermission}); err != nil {
		t.Fatal(err)
	}
	s.reporter.wait(t, 1)
	if err := Send(context.Background(), []string{s.path}, Message{Session: "ac-abc123", Status: protocol.StatusIdle}); err != nil {
		t.Fatal(err)
	}
	got := s.reporter.wait(t, 2)
	want := []report{{"ac-abc123", protocol.StatusNeedsApproval, protocol.ReasonPermission}, {"ac-abc123", protocol.StatusIdle, ""}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v", got)
	}
	s.cancel()
	<-s.done
	if _, err := os.Lstat(s.path); !os.IsNotExist(err) {
		t.Fatalf("socket left after shutdown: %v", err)
	}
}

func (s *served) waitLog(t *testing.T, text string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(s.logText(), text) {
		if time.Now().After(deadline) {
			t.Fatalf("log lacks %q: %s", text, s.logText())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAReportOlderThanTheLastAppliedIsDropped(t *testing.T) {
	s := serve(t, nil)
	send := func(m Message) {
		t.Helper()
		if err := Send(context.Background(), []string{s.path}, m); err != nil {
			t.Fatal(err)
		}
	}
	// Hooks started on this computer's clock, before the daemon reads it.
	clock := monoclock.Now()
	ms := int64(time.Millisecond)
	started := clock.At - 10*ms
	// The session ended; the background hook of the turn before arrives late.
	send(Message{Session: "ac-abc123", Status: protocol.StatusIdle, At: started, Clock: clock.Kind})
	s.reporter.wait(t, 1)
	send(Message{Session: "ac-abc123", Status: protocol.StatusWaiting, Reason: protocol.ReasonTurnEnd, At: started - ms, Clock: clock.Kind})
	s.waitLog(t, "hook_status_stale")
	send(Message{Session: "ac-abc123", Status: protocol.StatusRunning, Reason: protocol.ReasonInput, At: started + ms, Clock: clock.Kind})
	got := s.reporter.wait(t, 2)
	if len(got) != 2 || got[1].status != protocol.StatusRunning {
		t.Fatalf("got %+v", got)
	}
	// A report without a stamp, or of another clock, goes in arrival order.
	other := monoclock.Wall
	if clock.Kind == monoclock.Wall {
		other = monoclock.Mono
	}
	send(Message{Session: "ac-abc123", Status: protocol.StatusWaiting, Reason: protocol.ReasonTurnEnd, At: 1, Clock: other})
	s.reporter.wait(t, 3)
	send(Message{Session: "ac-abc123", Status: protocol.StatusIdle})
	if got := s.reporter.wait(t, 4); got[2].status != protocol.StatusWaiting || got[3].status != protocol.StatusIdle {
		t.Fatalf("got %+v", got)
	}
}

func TestSendTriesTheFallbackPath(t *testing.T) {
	s := serve(t, nil)
	missing := filepath.Join(shortDir(t), "none.sock")
	if err := Send(context.Background(), []string{missing, s.path}, Message{Session: "ac-abc123", Status: protocol.StatusRunning, Reason: protocol.ReasonInput}); err != nil {
		t.Fatal(err)
	}
	s.reporter.wait(t, 1)
}

// The tmux server keeps the environment of the `up` that started it, so a
// hook can see another XDG_RUNTIME_DIR than the daemon: the daemon listens
// on every candidate, and a hook reaches it either way.
func TestHooksReachTheDaemonWhateverRuntimeDirEitherSaw(t *testing.T) {
	runtime := shortDir(t)
	os.Chmod(runtime, 0o700)
	paths := config.Paths{StateDir: shortDir(t), TmuxSocket: "aiqsa-connect"}
	t.Setenv(config.EnvStateDir, "")
	msg := Message{Session: "ac-abc123", Status: protocol.StatusRunning, Reason: protocol.ReasonInput}
	for _, daemonHasRuntime := range []bool{true, false} {
		if daemonHasRuntime {
			t.Setenv("XDG_RUNTIME_DIR", runtime)
		} else {
			t.Setenv("XDG_RUNTIME_DIR", "")
		}
		reporter := newFakeReporter()
		server, err := Listen(Candidates(paths), reporter, logx.Discard(), nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, sock := range Candidates(paths) {
			if info, err := os.Lstat(sock); err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("socket %s: %v %v", sock, info, err)
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			server.Serve(ctx)
			close(done)
		}()
		for i, hookHasRuntime := range []bool{true, false} {
			if hookHasRuntime {
				t.Setenv("XDG_RUNTIME_DIR", runtime)
			} else {
				t.Setenv("XDG_RUNTIME_DIR", "")
			}
			if err := Send(context.Background(), Candidates(paths), msg); err != nil {
				t.Fatalf("daemon runtime dir %v, hook runtime dir %v: %v", daemonHasRuntime, hookHasRuntime, err)
			}
			reporter.wait(t, i+1)
		}
		cancel()
		<-done
		// Both socket files go with the daemon.
		for _, sock := range []string{filepath.Join(runtime, "aiqsa-connect.sock"), filepath.Join(paths.StateDir, "daemon.sock")} {
			if _, err := os.Lstat(sock); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s left behind: %v", sock, err)
			}
		}
	}
}

func TestListenOpensNothingWhenOneSocketFails(t *testing.T) {
	dir := shortDir(t)
	good := filepath.Join(dir, "a.sock")
	other := filepath.Join(dir, "file.sock")
	os.WriteFile(other, []byte("keep"), 0o600)
	if _, err := Listen([]string{good, other}, newFakeReporter(), logx.Discard(), nil); err == nil {
		t.Fatal("listened over a regular file")
	}
	if _, err := os.Lstat(good); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("first socket left open: %v", err)
	}
	if _, err := Listen(nil, newFakeReporter(), logx.Discard(), nil); err == nil {
		t.Fatal("listened on no path")
	}
}

func TestSendFailsFastWithoutADaemon(t *testing.T) {
	start := time.Now()
	err := Send(context.Background(), []string{filepath.Join(shortDir(t), "daemon.sock")}, Message{Session: "ac-abc123", Status: protocol.StatusIdle})
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("got %v after %v", err, time.Since(start))
	}
	if err := Send(context.Background(), nil, Message{Session: "bad", Status: protocol.StatusIdle}); err == nil {
		t.Fatal("an invalid message was sent")
	}
}

func TestBellsDoNotReplaceARecentHookStatus(t *testing.T) {
	now := time.Unix(1_000, 0)
	var mu sync.Mutex
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	s := serve(t, status.NewGate(clock))
	send := func(m Message) {
		t.Helper()
		if err := Send(context.Background(), []string{s.path}, m); err != nil {
			t.Fatal(err)
		}
	}
	bell := Message{Session: "ac-abc123", Status: protocol.StatusWaiting, Reason: protocol.ReasonBell}
	send(bell)
	s.reporter.wait(t, 1)
	send(Message{Session: "ac-abc123", Status: protocol.StatusRunning, Reason: protocol.ReasonInput})
	s.reporter.wait(t, 2)
	send(bell) // within 10 s of the hook: ignored
	send(Message{Session: "ac-xyz789", Status: protocol.StatusWaiting, Reason: protocol.ReasonBell})
	s.reporter.wait(t, 3)
	s.waitLog(t, "bell_ignored")
	mu.Lock()
	now = now.Add(status.BellQuietWindow)
	mu.Unlock()
	send(bell)
	got := s.reporter.wait(t, 4)
	if got[2].session != "ac-xyz789" || got[3] != (report{"ac-abc123", protocol.StatusWaiting, protocol.ReasonBell}) {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(s.logText(), "bell_ignored") {
		t.Fatalf("log: %s", s.logText())
	}
}

func TestTheDaemonRejectsInvalidAndOversizedMessages(t *testing.T) {
	s := serve(t, nil)
	for _, line := range []string{
		`{"session":"ac-abc123","status":"done"}`,
		`{"session":"../x","status":"idle"}`,
		`{"session":"ac-abc123","status":"waiting","reason":"bell","prompt":"secret"}`,
		`{"session":"ac-abc123","status":"idle","at":-1}`,
		`{"session":"ac-abc123","status":"idle","at":-1,"clock":"mono"}`,
		`{"session":"ac-abc123","status":"idle","at":5}`,
		`{"session":"ac-abc123","status":"idle","clock":"mono"}`,
		`{"session":"ac-abc123","status":"idle","at":5,"clock":"boot"}`,
		`not json`,
		`{"session":"ac-abc123","status":"waiting","reason":"` + strings.Repeat("x", 1024) + `"}`,
	} {
		conn, err := net.Dial("unix", s.path)
		if err != nil {
			t.Fatal(err)
		}
		conn.Write([]byte(line + "\n"))
		conn.Close()
	}
	// A valid message after the rejected ones still arrives, and is the only one.
	if err := Send(context.Background(), []string{s.path}, Message{Session: "ac-abc123", Status: protocol.StatusIdle}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := s.reporter.wait(t, 1); len(got) != 1 || got[0].status != protocol.StatusIdle {
		t.Fatalf("got %+v", got)
	}
	if log := s.logText(); strings.Contains(log, "secret") || !strings.Contains(log, "hook_message_rejected") {
		t.Fatalf("log: %s", log)
	}
}

func TestListenReplacesOnlyAStaleSocket(t *testing.T) {
	dir := shortDir(t)
	path := filepath.Join(dir, "daemon.sock")
	// A socket file left by a process that is gone.
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()
	server, err := Listen([]string{path}, newFakeReporter(), logx.Discard(), nil)
	if err != nil {
		t.Fatalf("stale socket: %v", err)
	}
	// A live socket belongs to another daemon.
	if _, err := Listen([]string{path}, newFakeReporter(), logx.Discard(), nil); err == nil || !strings.Contains(err.Error(), "already listening") {
		t.Fatalf("live socket: %v", err)
	}
	server.Close()
	// Any other file is never removed.
	other := filepath.Join(dir, "file.sock")
	os.WriteFile(other, []byte("keep"), 0o600)
	if _, err := Listen([]string{other}, newFakeReporter(), logx.Discard(), nil); err == nil {
		t.Fatal("listened over a regular file")
	}
	if data, _ := os.ReadFile(other); string(data) != "keep" {
		t.Fatal("regular file changed")
	}
}

func TestPathFollowsTheOverridesAndThePrivateRuntimeDir(t *testing.T) {
	paths := config.Paths{StateDir: "/state", TmuxSocket: "aiqsa-connect"}
	runtime := shortDir(t)
	os.Chmod(runtime, 0o700)
	t.Setenv("XDG_RUNTIME_DIR", runtime)
	t.Setenv(config.EnvStateDir, "")
	if got := Path(paths); got != filepath.Join(runtime, "aiqsa-connect.sock") {
		t.Fatalf("runtime dir: %s", got)
	}
	if got := Candidates(paths); len(got) != 2 || got[1] != "/state/daemon.sock" {
		t.Fatalf("candidates: %v", got)
	}
	paths.TmuxSocket = "aiqsa-connect-test"
	if got := Path(paths); got != filepath.Join(runtime, "aiqsa-connect-test.sock") {
		t.Fatalf("own tmux socket: %s", got)
	}
	os.Chmod(runtime, 0o755)
	if got := Path(paths); got != "/state/daemon.sock" {
		t.Fatalf("shared runtime dir: %s", got)
	}
	os.Chmod(runtime, 0o700)
	t.Setenv(config.EnvStateDir, "/state")
	if got := Path(paths); got != "/state/daemon.sock" {
		t.Fatalf("state dir override: %s", got)
	}
	if got := Candidates(paths); len(got) != 1 {
		t.Fatalf("candidates: %v", got)
	}
	t.Setenv(config.EnvStateDir, "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	if got := Path(paths); got != "/state/daemon.sock" {
		t.Fatalf("no runtime dir: %s", got)
	}
}
