package daemon

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

const (
	viewA     = "aaaaaaaa-0000-4000-8000-000000000001"
	viewB     = "bbbbbbbb-0000-4000-8000-000000000002"
	viewC     = "cccccccc-0000-4000-8000-000000000003"
	requestA  = "aaaaaaaa-1111-4000-8000-000000000001"
	requestB  = "bbbbbbbb-1111-4000-8000-000000000002"
	requestC  = "cccccccc-1111-4000-8000-000000000003"
	requestD  = "dddddddd-1111-4000-8000-000000000004"
	requestE  = "eeeeeeee-1111-4000-8000-000000000005"
	requestF  = "ffffffff-1111-4000-8000-000000000006"
	titleMark = "zq-title-marker"
)

func findReply(events []protocol.DeviceEvent, id string) *protocol.ReplyEvent {
	for _, e := range events {
		if reply, ok := e.(*protocol.ReplyEvent); ok && reply.RequestID == id {
			return reply
		}
	}
	return nil
}

func lastSnapshot(events []protocol.DeviceEvent) *protocol.SessionsEvent {
	for i := len(events) - 1; i >= 0; i-- {
		if s, ok := events[i].(*protocol.SessionsEvent); ok {
			return s
		}
	}
	return nil
}

func findSession(snapshot *protocol.SessionsEvent, id string) *protocol.Session {
	if snapshot == nil {
		return nil
	}
	for i := range snapshot.Sessions {
		if snapshot.Sessions[i].ID == id {
			return &snapshot.Sessions[i]
		}
	}
	return nil
}

// viewOutput concatenates a view's output and checks seq runs 0, 1, 2, ….
func viewOutput(t *testing.T, events []protocol.DeviceEvent, viewID string) string {
	t.Helper()
	var out bytes.Buffer
	var next uint64
	for _, e := range events {
		if o, ok := e.(*protocol.OutputEvent); ok && o.ViewID == viewID {
			if o.Seq != next {
				t.Fatalf("seq %d, want %d", o.Seq, next)
			}
			next++
			out.Write(o.Data)
		}
	}
	return out.String()
}

func closedReason(events []protocol.DeviceEvent, viewID string) protocol.ViewClosedReason {
	for _, e := range events {
		if c, ok := e.(*protocol.ViewClosedEvent); ok && c.ViewID == viewID {
			return c.Reason
		}
	}
	return ""
}

func TestSessionsAndViewsWithRealTmux(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	server.limits.MaxOutputChunkBytes = 512
	h := newHarness(t, server, ts.Manager, fastTiming())
	h.start()
	stream := server.nextStream(t)
	ctx := context.Background()

	dir := t.TempDir()
	stream.command(map[string]any{"type": "session_create", "requestId": requestA, "program": "shell", "cwd": dir, "title": titleMark})
	events := server.waitUntil(t, "create reply", func(e []protocol.DeviceEvent) bool { return findReply(e, requestA) != nil })
	reply := findReply(events, requestA)
	if !reply.OK {
		t.Fatalf("create failed: %v", *reply.Code)
	}
	created, _ := protocol.DecodeCommandResult(protocol.CommandSessionCreate, reply.Result)
	sessionID := created.(*protocol.SessionCreateResult).SessionID
	session := findSession(lastSnapshot(events), sessionID)
	if session == nil || session.Title != titleMark || session.Cwd != dir || session.Program != protocol.ProgramShell || session.Status != protocol.StatusIdle {
		t.Fatalf("snapshot before reply: %+v", session)
	}

	stream.command(map[string]any{"type": "view_open", "viewId": viewA, "sessionId": sessionID, "cols": 80, "rows": 24})
	server.waitUntil(t, "first output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewA) != "" })
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "echo aiqsa$((6*7))\r"})
	events = server.waitUntil(t, "echo output", func(e []protocol.DeviceEvent) bool {
		return strings.Contains(viewOutput(t, e, viewA), "aiqsa42")
	})
	if width, _ := ts.Manager.Display(ctx, sessionID, "#{window_width}"); width != "80" {
		t.Fatalf("width after open: %q", width)
	}
	stream.command(map[string]any{"type": "view_resize", "viewId": viewA, "cols": 100, "rows": 30})
	waitFor(t, "resize", func() bool {
		width, _ := ts.Manager.Display(ctx, sessionID, "#{window_width}")
		return width == "100"
	})
	events = server.waitUntil(t, "attached snapshot", func(e []protocol.DeviceEvent) bool {
		s := findSession(lastSnapshot(e), sessionID)
		return s != nil && s.AttachedClients == 1
	})
	// A shell has no agent turns: input leaves its status alone.
	if s := findSession(lastSnapshot(events), sessionID); s.Status != protocol.StatusIdle || statusEvents(events, sessionID) != 0 {
		t.Fatalf("shell input changed status: %+v, %d status events", s, statusEvents(events, sessionID))
	}
	if v, _ := ts.Manager.Option(ctx, sessionID, tmux.OptionStatus); v != string(protocol.StatusIdle) {
		t.Fatalf("shell status option after input: %q", v)
	}

	stream.command(map[string]any{"type": "view_close", "viewId": viewA})
	server.waitUntil(t, "detached snapshot", func(e []protocol.DeviceEvent) bool {
		s := findSession(lastSnapshot(e), sessionID)
		return s != nil && s.AttachedClients == 0
	})
	if exists, _ := ts.Manager.Exists(ctx, sessionID); !exists {
		t.Fatal("closing the view ended the session")
	}

	stream.command(map[string]any{"type": "session_history", "requestId": requestB, "sessionId": sessionID})
	stream.command(map[string]any{"type": "session_options", "requestId": requestC, "sessionId": sessionID})
	stream.command(map[string]any{"type": "session_history", "requestId": requestD, "sessionId": "ac-missing0"})
	events = server.waitUntil(t, "history replies", func(e []protocol.DeviceEvent) bool {
		return findReply(e, requestB) != nil && findReply(e, requestC) != nil && findReply(e, requestD) != nil
	})
	history, err := protocol.DecodeCommandResult(protocol.CommandSessionHistory, findReply(events, requestB).Result)
	if err != nil || !strings.Contains(history.(*protocol.SessionHistoryResult).Text, "aiqsa42") {
		t.Fatalf("history: %v %v", history, err)
	}
	options, err := protocol.DecodeCommandResult(protocol.CommandSessionOptions, findReply(events, requestC).Result)
	if err != nil || len(options.(*protocol.SessionOptionsResult).Options) != 0 {
		t.Fatalf("options: %v %v", options, err)
	}
	if missing := findReply(events, requestD); missing.OK || *missing.Code != protocol.CodeSessionNotFound {
		t.Fatalf("missing session: %+v", missing)
	}

	stream.command(map[string]any{"type": "view_open", "viewId": viewB, "sessionId": "ac-missing0", "cols": 80, "rows": 24})
	stream.command(map[string]any{"type": "view_open", "viewId": viewC, "sessionId": sessionID, "cols": 80, "rows": 24})
	server.waitUntil(t, "second view output", func(e []protocol.DeviceEvent) bool {
		return closedReason(e, viewB) == protocol.ViewClosedSessionEnded && viewOutput(t, e, viewC) != ""
	})
	stream.command(map[string]any{"type": "session_kill", "requestId": requestE, "sessionId": sessionID})
	events = server.waitUntil(t, "kill", func(e []protocol.DeviceEvent) bool {
		return findReply(e, requestE) != nil && closedReason(e, viewC) != ""
	})
	if kill := findReply(events, requestE); !kill.OK || string(kill.Result) != "{}" {
		t.Fatalf("kill reply: %+v", kill)
	}
	if reason := closedReason(events, viewC); reason != protocol.ViewClosedSessionEnded {
		t.Fatalf("view of a killed session closed with %q", reason)
	}
	if exists, _ := ts.Manager.Exists(ctx, sessionID); exists {
		t.Fatal("session survived kill")
	}

	// Metadata lives in tmux: a restarted daemon reports the same session.
	stream.command(map[string]any{"type": "session_create", "requestId": requestF, "program": "shell", "cwd": "~"})
	events = server.waitUntil(t, "second create", func(e []protocol.DeviceEvent) bool { return findReply(e, requestF) != nil })
	created, _ = protocol.DecodeCommandResult(protocol.CommandSessionCreate, findReply(events, requestF).Result)
	secondID := created.(*protocol.SessionCreateResult).SessionID
	before := findSession(lastSnapshot(events), secondID)
	if before == nil || before.Title != "Shell · "+lastSegment(h.daemon.home) {
		t.Fatalf("default title: %+v", before)
	}
	h.stop(t)
	if exists, _ := ts.Manager.Exists(ctx, secondID); !exists {
		t.Fatal("stopping the daemon ended the session")
	}
	server.mu.Lock()
	server.recorded = nil
	server.mu.Unlock()
	h2 := newHarness(t, server, ts.Manager, fastTiming())
	h2.start()
	server.nextStream(t)
	events = server.waitUntil(t, "snapshot after restart", func(e []protocol.DeviceEvent) bool { return lastSnapshot(e) != nil })
	after := findSession(lastSnapshot(events), secondID)
	if after == nil || after.Title != before.Title || after.Program != before.Program || after.CreatedAt != before.CreatedAt || after.StatusAt != before.StatusAt {
		t.Fatalf("after restart: %+v, before %+v", after, before)
	}
	h2.stop(t)

	log := h.log.String() + h2.log.String()
	for _, leak := range []string{"aiqsa42", "aiqsa$", "echo", titleMark, dir, testToken, sessionID} {
		if strings.Contains(log, leak) {
			t.Errorf("log contains %q:\n%s", leak, log)
		}
	}
	if !strings.Contains(log, "view_open") || !strings.Contains(log, "reply") {
		t.Errorf("log lacks events:\n%s", log)
	}
}

func statusEvents(events []protocol.DeviceEvent, sessionID string) int {
	count := 0
	for _, e := range events {
		if s, ok := e.(*protocol.StatusEvent); ok && s.SessionID == sessionID {
			count++
		}
	}
	return count
}

// Input from a view marks an agent session running, once.
func TestAgentInputMarksRunningWithRealTmux(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	h := newHarness(t, server, ts.Manager, fastTiming())
	ctx := context.Background()
	// A shell session labeled claude: the test never starts a real agent.
	id, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ts.Manager.SetOptions(ctx, id, tmux.OptionProgram, string(protocol.ProgramClaude)); err != nil {
		t.Fatal(err)
	}
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "view_open", "viewId": viewA, "sessionId": id, "cols": 80, "rows": 24})
	server.waitUntil(t, "first output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewA) != "" })
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "echo first$((6*7))\r"})
	server.waitUntil(t, "running status", func(e []protocol.DeviceEvent) bool {
		for _, event := range e {
			if s, ok := event.(*protocol.StatusEvent); ok && s.SessionID == id && s.Status == protocol.StatusRunning &&
				s.Reason != nil && *s.Reason == protocol.ReasonInput {
				return true
			}
		}
		return false
	})
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "echo second$((6*7))\r"})
	events := server.waitUntil(t, "running snapshot", func(e []protocol.DeviceEvent) bool {
		s := findSession(lastSnapshot(e), id)
		return strings.Contains(viewOutput(t, e, viewA), "second42") && s != nil && s.Status == protocol.StatusRunning
	})
	if n := statusEvents(events, id); n != 1 {
		t.Fatalf("%d status events, want 1", n)
	}
	if v, _ := ts.Manager.Option(ctx, id, tmux.OptionStatus); v != string(protocol.StatusRunning) {
		t.Fatalf("status option: %q", v)
	}
	h.stop(t)
}

func TestReportStatusWithRealTmux(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	h := newHarness(t, server, ts.Manager, fastTiming())
	ctx := context.Background()
	id, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	// Offline: only tmux changes.
	if err := h.daemon.ReportStatus(id, protocol.StatusWaiting, protocol.ReasonTurnEnd); err != nil {
		t.Fatal(err)
	}
	if v, _ := ts.Manager.Option(ctx, id, tmux.OptionStatus); v != "waiting" {
		t.Fatalf("status option: %q", v)
	}
	h.start()
	server.nextStream(t)
	server.waitUntil(t, "snapshot", func(e []protocol.DeviceEvent) bool {
		s := findSession(lastSnapshot(e), id)
		return s != nil && s.Status == protocol.StatusWaiting
	})
	for range 3 {
		if err := h.daemon.ReportStatus(id, protocol.StatusNeedsApproval, protocol.ReasonPermission); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.daemon.ReportStatus(id, protocol.StatusIdle, ""); err != nil {
		t.Fatal(err)
	}
	events := server.waitUntil(t, "idle status", func(e []protocol.DeviceEvent) bool {
		for _, event := range e {
			if s, ok := event.(*protocol.StatusEvent); ok && s.Status == protocol.StatusIdle && s.Reason == nil {
				return true
			}
		}
		return false
	})
	approvals := 0
	for _, event := range events {
		if s, ok := event.(*protocol.StatusEvent); ok && s.Status == protocol.StatusNeedsApproval {
			approvals++
		}
	}
	if approvals != 1 {
		t.Fatalf("needs_approval sent %d times", approvals)
	}
	if err := h.daemon.ReportStatus("ac-missing0", protocol.StatusIdle, ""); err == nil {
		t.Fatal("unknown session accepted")
	}
	if err := h.daemon.ReportStatus(id, "busy", ""); err == nil {
		t.Fatal("invalid status accepted")
	}
	h.stop(t)
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func lastSegment(path string) string {
	return path[strings.LastIndex(path, "/")+1:]
}
