package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/ops"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/state"
)

const (
	requestID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
	runID     = "11111111-2222-4333-8444-555555555555"
	otherRun  = "11111111-2222-4333-8444-666666666666"
)

func requestN(n int) string { return fmt.Sprintf("a1b2c3d4-e5f6-4a7b-8c9d-%012d", n) }

func opCommand(id, run string, op protocol.Op, args any) map[string]any {
	return map[string]any{"type": "op", "requestId": id, "runId": run, "op": op, "args": args, "deadlineMs": 60_000}
}

// shSystem runs commands with /bin/sh instead of the user's login shell.
type shSystem struct{ ops.System }

func (shSystem) DetectShell() ops.Shell {
	return ops.Shell{Kind: protocol.ShellPOSIX, Name: "sh", Path: "/bin/sh"}
}

func newShHarness(t *testing.T, server *fakeServer) *harness {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	h := newHarness(t, server, fastTiming())
	h.daemon.exec = ops.New(ops.Options{Home: h.home, Log: h.daemon.log, System: shSystem{ops.Native()}})
	return h
}

func TestDeviceInfoAndStatesOnConnectAndReconnectAfterDrop(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fastTiming())
	h.start()
	first := server.nextStream(t)
	info := server.waitEvent(t, isType(protocol.EventDeviceInfo)).(*protocol.DeviceInfoEvent)
	if info.Home != h.home || info.OS != protocol.OS(runtime.GOOS) || info.Shell.Kind != protocol.ShellPOSIX || info.Hostname == "" || info.OSVersion == "" {
		t.Fatalf("device_info: %+v", info)
	}
	if h.updater.count() != 1 || h.updater.calls[0] != [2]string{"1.2.4", "1.0.0"} {
		t.Fatalf("updater: %v", h.updater.calls)
	}
	first.drop()
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventDeviceInfo))
	if !strings.Contains(h.notices.String(), "reconnecting") {
		t.Errorf("notices: %q", h.notices.String())
	}
	h.stop(t)
	want := []state.Kind{state.Connecting, state.Connected, state.Offline, state.Connecting, state.Connected, state.Stopped}
	if got := h.states.kinds(); !slices.Equal(got, want) {
		t.Fatalf("states: %v", got)
	}
	for _, s := range h.states.states {
		if s.Origin != server.srv.URL || s.UserCode != "" {
			t.Fatalf("state: %+v", s)
		}
	}
}

func TestRevokedWhenStreamIsUnauthorized(t *testing.T) {
	server := newFakeServer(t)
	server.streamRefusal = &refusal{http.StatusUnauthorized, protocol.CodeUnauthorized}
	h := newHarness(t, server, fastTiming())
	h.start()
	if err := h.wait(t); !errors.Is(err, ErrRevoked) {
		t.Fatalf("got %v", err)
	}
	if server.streamOpens.Load() != 1 {
		t.Fatalf("retried after revocation: %d", server.streamOpens.Load())
	}
	if got := h.states.kinds(); !slices.Equal(got, []state.Kind{state.Connecting, state.Revoked}) {
		t.Fatalf("states: %v", got)
	}
}

func TestStreamClosedAndReplaced(t *testing.T) {
	cases := []struct {
		name string
		send func(*fakeStream)
		want error
	}{
		{"closed unauthorized", func(s *fakeStream) {
			s.send(protocol.StreamEventClosed, map[string]string{"code": "connect_unauthorized"})
		}, ErrRevoked},
		{"replaced", func(s *fakeStream) { s.send(protocol.StreamEventReplaced, map[string]any{}) }, ErrReplaced},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := newFakeServer(t)
			h := newHarness(t, server, fastTiming())
			h.start()
			stream := server.nextStream(t)
			server.waitEvent(t, isType(protocol.EventDeviceInfo))
			tc.send(stream)
			if err := h.wait(t); !errors.Is(err, tc.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestDisabledWaitsAndOutdatedCallsUpdater(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fastTiming())
	h.start()
	stream := server.nextStream(t)
	stream.send(protocol.StreamEventClosed, map[string]string{"code": "connect_disabled"})
	stream = server.nextStream(t)
	if !strings.Contains(h.notices.String(), "turned off") {
		t.Errorf("notices: %q", h.notices.String())
	}
	stream.send(protocol.StreamEventClosed, map[string]string{"code": "connect_client_outdated"})
	server.nextStream(t)
	// One call per hello plus one for the outdated refusal.
	if got := h.updater.count(); got != 3 {
		t.Errorf("updater calls: %d", got)
	}
	h.stop(t)
	kinds := h.states.kinds()
	if !slices.Contains(kinds, state.Disabled) || !slices.Contains(kinds, state.Outdated) {
		t.Errorf("states: %v", kinds)
	}
	server.streamRefusal = &refusal{http.StatusForbidden, protocol.CodeDisabled}
	h2 := newHarness(t, server, fastTiming())
	h2.start()
	time.Sleep(200 * time.Millisecond)
	opens := server.streamOpens.Load()
	h2.stop(t)
	if opens < 2 || opens > 12 {
		t.Errorf("disabled retry count: %d", opens)
	}
}

// A server that refuses this client before any hello (426) starts the
// update, with the values of no hello.
func TestStatus426IsTheOutdatedPath(t *testing.T) {
	server := newFakeServer(t)
	server.streamRefusal = &refusal{http.StatusUpgradeRequired, protocol.CodeClientOutdated}
	h := newHarness(t, server, fastTiming())
	h.start()
	deadline := time.Now().Add(10 * time.Second)
	for h.updater.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	h.stop(t)
	h.updater.mu.Lock()
	calls := slices.Clone(h.updater.calls)
	h.updater.mu.Unlock()
	if len(calls) == 0 || calls[0] != [2]string{"", ""} {
		t.Fatalf("updater: %v", calls)
	}
	if !slices.Contains(h.states.kinds(), state.Outdated) {
		t.Fatalf("states: %v", h.states.kinds())
	}
	if server.requests.Load() == 0 {
		t.Fatal("no request")
	}
}

func TestIdleStreamReconnects(t *testing.T) {
	server := newFakeServer(t)
	timing := fastTiming()
	timing.IdleTimeout = 150 * time.Millisecond
	h := newHarness(t, server, timing)
	h.start()
	server.nextStream(t)
	started := time.Now()
	server.nextStream(t)
	if elapsed := time.Since(started); elapsed < 100*time.Millisecond {
		t.Errorf("reconnected after %v", elapsed)
	}
	h.stop(t)
}

func TestUnknownCommandsAndOpsAreAnsweredUnsupported(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fastTiming())
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "future_command", "requestId": requestID, "extra": 1})
	stream.command(map[string]any{"type": "another_future_command"})
	stream.command(map[string]any{"type": "op", "requestId": requestN(2), "runId": runID, "op": "screenshot", "args": map[string]any{}, "deadlineMs": 1000})
	for _, id := range []string{requestID, requestN(2)} {
		reply := server.waitEvent(t, replyFor(id)).(*protocol.OpReplyEvent)
		if reply.OK || reply.Code == nil || *reply.Code != protocol.CodeUnsupported {
			t.Fatalf("reply: %+v", reply)
		}
	}
	h.stop(t)
}

func decodeReply(t *testing.T, server *fakeServer, id string, op protocol.Op) protocol.Validator {
	t.Helper()
	reply := server.waitEvent(t, replyFor(id)).(*protocol.OpReplyEvent)
	if !reply.OK {
		t.Fatalf("%s: code %s", op, *reply.Code)
	}
	result, err := protocol.DecodeOpResult(op, reply.Result)
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
	return result
}

// Every op answers with its result shape over a protocol 2 stream.
func TestOpsAnswerWithTheirResults(t *testing.T) {
	server := newFakeServer(t)
	h := newShHarness(t, server)
	h.start()
	stream := server.nextStream(t)
	cwd := filepath.Join(h.home, "work")
	os.MkdirAll(filepath.Join(cwd, "sub"), 0o755)
	n := 0
	do := func(op protocol.Op, args any) protocol.Validator {
		t.Helper()
		n++
		id := requestN(n)
		stream.command(opCommand(id, runID, op, args))
		return decodeReply(t, server, id, op)
	}
	write := do(protocol.OpWrite, map[string]any{"path": "notes/a.txt", "cwd": cwd, "content": "hello\nworld\n"}).(*protocol.WriteResult)
	if !write.Created || write.Bytes != 12 {
		t.Fatalf("write: %+v", write)
	}
	read := do(protocol.OpRead, map[string]any{"path": "notes/a.txt", "cwd": cwd, "offset": 1, "limit": 2000}).(*protocol.ReadResult)
	if read.Content != "hello\nworld\n" || read.TotalLines != 2 || read.Encoding != "utf-8" || read.LineEnding != protocol.LineEndingLF {
		t.Fatalf("read: %+v", read)
	}
	edit := do(protocol.OpEdit, map[string]any{"path": "notes/a.txt", "cwd": cwd, "oldString": "world", "newString": "there", "replaceAll": false}).(*protocol.EditResult)
	if edit.Replacements != 1 {
		t.Fatalf("edit: %+v", edit)
	}
	glob := do(protocol.OpGlob, map[string]any{"pattern": "**/*.txt", "cwd": cwd}).(*protocol.GlobResult)
	if len(glob.Paths) != 1 || glob.Paths[0] != filepath.Join(cwd, "notes", "a.txt") {
		t.Fatalf("glob: %+v", glob)
	}
	grep := do(protocol.OpGrep, map[string]any{"pattern": "THERE", "cwd": cwd, "ignoreCase": true, "mode": "content", "context": 1}).(*protocol.GrepResult)
	if len(grep.Matches) != 2 || *grep.Matches[1].Text != "there" || *grep.Matches[1].Line != 2 || grep.Matches[0].Context == nil {
		t.Fatalf("grep: %+v", grep)
	}
	stat := do(protocol.OpStat, map[string]any{"path": cwd}).(*protocol.StatResult)
	if !stat.Exists || *stat.Kind != protocol.StatDir || *stat.Path != cwd {
		t.Fatalf("stat: %+v", stat)
	}
	list := do(protocol.OpListDirs, map[string]any{"path": "~/work"}).(*protocol.ListDirsResult)
	if list.Path != cwd || !slices.Equal(list.Dirs, []string{"notes", "sub"}) || *list.Parent != h.home {
		t.Fatalf("list_dirs: %+v", list)
	}
	recent := do(protocol.OpRecentDirs, map[string]any{}).(*protocol.OpRecentDirsResult)
	if recent.Home != h.home || len(recent.Dirs) == 0 || recent.Dirs[0] != cwd {
		t.Fatalf("recent_dirs: %+v", recent)
	}
	shell := do(protocol.OpShell, map[string]any{"command": "echo hi; echo oops >&2; exit 3", "cwd": cwd, "timeoutSeconds": 30, "background": false}).(*protocol.ShellResult)
	if shell.ExitCode != 3 || shell.Stdout != "hi\n" || shell.Stderr != "oops\n" || shell.StdoutBytes != 3 || shell.Truncated {
		t.Fatalf("shell: %+v", shell)
	}
	job := do(protocol.OpShell, map[string]any{"command": "echo bg", "cwd": cwd, "timeoutSeconds": 30, "background": true}).(*protocol.ShellJobResult)
	var output *protocol.JobOutputResult
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		output = do(protocol.OpJobOutput, map[string]any{"jobId": job.JobID, "waitSeconds": 5}).(*protocol.JobOutputResult)
		if !output.Running {
			break
		}
	}
	if output.Running || *output.ExitCode != 0 {
		t.Fatalf("job_output: %+v", output)
	}
	stop := do(protocol.OpJobStop, map[string]any{"jobId": job.JobID}).(*protocol.JobStopResult)
	if stop.Stopped {
		t.Fatalf("job_stop of an ended job: %+v", stop)
	}
	h.stop(t)
	if log := h.log.String(); strings.Contains(log, "hello") || strings.Contains(log, cwd) || strings.Contains(log, "echo") {
		t.Fatalf("log holds content:\n%s", log)
	}
}

func TestEventsRefusalsReconnectOrRevoke(t *testing.T) {
	server := newFakeServer(t)
	server.eventsReplies = []refusal{{http.StatusServiceUnavailable, ""}, {http.StatusConflict, protocol.CodeStreamRequired}}
	h := newHarness(t, server, fastTiming())
	h.start()
	server.nextStream(t)
	// 503 is retried, 409 forces a new stream, whose device_info then arrives.
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventDeviceInfo))
	server.mu.Lock()
	server.eventsReplies = []refusal{{http.StatusUnauthorized, protocol.CodeUnauthorized}}
	server.mu.Unlock()
	h.daemon.current().push(protocol.NewOpReplyError(requestID, protocol.CodeComputerLimit))
	if err := h.wait(t); !errors.Is(err, ErrRevoked) {
		t.Fatalf("got %v", err)
	}
}

func TestSenderPostsSeriallyWithinLimits(t *testing.T) {
	server := newFakeServer(t)
	server.limits.MaxEventsPerPost = 5
	server.limits.MaxEventsBodyBytes = 2000
	server.eventsDelay = 5 * time.Millisecond
	h := newHarness(t, server, fastTiming())
	h.start()
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventDeviceInfo))
	conn := h.daemon.current()
	const total = 120
	for i := range total {
		conn.push(protocol.NewOpReplyError(requestN(i), protocol.CodeComputerLimit))
	}
	for i := range total {
		event := server.waitEvent(t, isType(protocol.EventReply)).(*protocol.OpReplyEvent)
		if want := requestN(i); event.RequestID != want {
			t.Fatalf("order: got %s want %s", event.RequestID, want)
		}
	}
	h.stop(t)
	if server.maxInFlight.Load() != 1 {
		t.Fatalf("posts in flight at once: %d", server.maxInFlight.Load())
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.batchSizes) < total/5 {
		t.Fatalf("batches: %v", server.batchSizes)
	}
	for i, n := range server.batchSizes {
		if n > 5 || server.batchBytes[i] > 2000 {
			t.Fatalf("batch %d: %d events %d bytes", i, n, server.batchBytes[i])
		}
	}
}

func TestOutboxBatchesWithinBounds(t *testing.T) {
	o := newOutbox()
	o.push([]byte("x"))
	o.push([]byte(strings.Repeat("y", 50)))
	o.push([]byte(strings.Repeat("z", 50)))
	if batch := o.take(context.Background(), 10, 80); len(batch) != 2 || o.pending() != 1 {
		t.Fatalf("byte bound: %d %d", len(batch), o.pending())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	o.take(context.Background(), 10, 1000)
	if batch := o.take(ctx, 10, 1000); batch != nil {
		t.Fatalf("take after cancel: %v", batch)
	}
}

// fakeLocker stands in for flock and LockFileEx.
type fakeLocker struct {
	held     map[string]bool
	unlocked int
}

func (f *fakeLocker) tryLock(file *os.File) (bool, error) {
	if f.held[file.Name()] {
		return true, nil
	}
	f.held[file.Name()] = true
	return false, nil
}

func (f *fakeLocker) unlock(file *os.File) {
	delete(f.held, file.Name())
	f.unlocked++
}

func TestTheLockIsTakenOnce(t *testing.T) {
	locker := &fakeLocker{held: map[string]bool{}}
	path := filepath.Join(t.TempDir(), "up.lock")
	release, err := acquireLock(locker, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireLock(locker, path); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second lock: %v", err)
	}
	release()
	if locker.unlocked != 1 {
		t.Fatalf("unlocked %d times", locker.unlocked)
	}
	release, err = acquireLock(locker, path)
	if err != nil {
		t.Fatal(err)
	}
	release()
	// The real lock as well.
	release, err = AcquireLock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := AcquireLock(path); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second real lock: %v", err)
	}
}
