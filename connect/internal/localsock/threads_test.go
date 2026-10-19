package localsock

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/monoclock"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func TestThreadBindingsAreBoundedAndForgetTheLeastRecentlyUsed(t *testing.T) {
	m := newThreads()
	for i := range maxThreads {
		m.bind(fmt.Sprintf("t%d", i), "ac-abc123")
	}
	// t0 was used last; t1 is now the least recently used.
	if s, ok := m.session("t0"); !ok || s != "ac-abc123" {
		t.Fatalf("t0: %q %v", s, ok)
	}
	m.bind("new", "ac-xyz789")
	if len(m.bound) != maxThreads {
		t.Fatalf("%d bindings, want %d", len(m.bound), maxThreads)
	}
	if _, ok := m.session("t1"); ok {
		t.Fatal("the least recently used binding was kept")
	}
	for _, id := range []string{"t0", "t2", "new"} {
		if _, ok := m.session(id); !ok {
			t.Fatalf("%s was dropped", id)
		}
	}
	// Rebinding an existing thread evicts nothing.
	m.bind("t2", "ac-xyz789")
	if s, _ := m.session("t2"); s != "ac-xyz789" || len(m.bound) != maxThreads {
		t.Fatalf("rebind: %q, %d bindings", s, len(m.bound))
	}
	m.forgetSession("ac-xyz789")
	for _, id := range []string{"t2", "new"} {
		if _, ok := m.session(id); ok {
			t.Fatalf("%s outlived its session", id)
		}
	}
	if _, ok := m.session("t0"); !ok {
		t.Fatal("a thread of another session was forgotten")
	}
}

// goneReporter is a fakeReporter whose sessions in gone no longer exist.
type goneReporter struct {
	*fakeReporter
	gone map[string]bool
}

func (g goneReporter) ReportStatus(session string, s protocol.SessionStatus, r protocol.StatusReason) error {
	if g.gone[session] {
		g.fakeReporter.got <- struct{}{}
		return tmux.ErrSessionNotFound
	}
	return g.fakeReporter.ReportStatus(session, s, r)
}

func TestAThreadOnlyReportAppliesToTheSessionItIsBoundTo(t *testing.T) {
	s := serve(t, nil)
	send := func(m Message) {
		t.Helper()
		if err := Send(context.Background(), []string{s.path}, m); err != nil {
			t.Fatal(err)
		}
	}
	// Hook start times in event order, before the daemon reads its clock.
	clock := monoclock.Now()
	at := clock.At - int64(time.Second)
	stamped := func(m Message) Message {
		at += int64(time.Millisecond)
		m.At, m.Clock = at, clock.Kind
		return m
	}
	running := func(session, thread string) Message {
		return stamped(Message{Session: session, Thread: thread, Status: protocol.StatusRunning, Reason: protocol.ReasonInput})
	}
	stop := func(thread string) Message {
		return stamped(Message{Thread: thread, Status: protocol.StatusWaiting, Reason: protocol.ReasonTurnEnd})
	}
	// An unknown thread is dropped, with a code only.
	send(stop("019a-unknown"))
	s.waitLog(t, "hook_thread_unbound")
	// Each connection is served on its own: wait for the binding report.
	send(running("ac-abc123", "019a-thread"))
	s.reporter.wait(t, 1)
	send(stop("019a-thread"))
	got := s.reporter.wait(t, 2)
	if got[1] != (report{"ac-abc123", protocol.StatusWaiting, protocol.ReasonTurnEnd}) {
		t.Fatalf("got %+v", got)
	}
	// Rebinding moves the thread to the other session.
	send(running("ac-xyz789", "019a-thread"))
	s.reporter.wait(t, 3)
	send(stop("019a-thread"))
	got = s.reporter.wait(t, 4)
	if got[3] != (report{"ac-xyz789", protocol.StatusWaiting, protocol.ReasonTurnEnd}) {
		t.Fatalf("got %+v", got)
	}
	if log := s.logText(); strings.Contains(log, "019a") {
		t.Fatalf("the log names a thread: %s", log)
	}
}

func TestAThreadOfAGoneSessionIsUnbound(t *testing.T) {
	path := shortDir(t) + "/daemon.sock"
	reporter := goneReporter{newFakeReporter(), map[string]bool{}}
	server, err := Listen([]string{path}, reporter, logx.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		server.Serve(ctx)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	send := func(m Message) {
		t.Helper()
		if err := Send(context.Background(), []string{path}, m); err != nil {
			t.Fatal(err)
		}
	}
	send(Message{Session: "ac-abc123", Thread: "t1", Status: protocol.StatusRunning, Reason: protocol.ReasonInput})
	reporter.wait(t, 1)
	server.applyMu.Lock()
	reporter.gone["ac-abc123"] = true
	server.applyMu.Unlock()
	send(Message{Thread: "t1", Status: protocol.StatusWaiting, Reason: protocol.ReasonTurnEnd})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, bound := server.threads.session("t1"); !bound {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the thread of a gone session stayed bound")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestTheDaemonRejectsInvalidThreadMessages(t *testing.T) {
	s := serve(t, nil)
	for _, line := range []string{
		`{"status":"idle"}`,
		`{"session":"","thread":"","status":"idle"}`,
		`{"thread":"a b","status":"idle"}`,
		`{"thread":"` + strings.Repeat("a", 129) + `","status":"idle"}`,
		`{"session":"ac-abc123","thread":"../x","status":"idle"}`,
		`{"thread":"t1","status":"waiting","reason":"bell"}`,
		`{"thread":["t1"],"status":"idle"}`,
	} {
		conn, err := net.Dial("unix", s.path)
		if err != nil {
			t.Fatal(err)
		}
		conn.Write([]byte(line + "\n"))
		conn.Close()
	}
	for _, m := range []Message{{Status: protocol.StatusIdle}, {Thread: "a/b", Status: protocol.StatusIdle}, {Thread: "t1", Status: protocol.StatusWaiting, Reason: protocol.ReasonBell}} {
		if err := Send(context.Background(), []string{s.path}, m); err == nil {
			t.Fatalf("sent %+v", m)
		}
	}
	// None of them bound anything: the thread below is unknown.
	if err := Send(context.Background(), []string{s.path}, Message{Thread: "t1", Status: protocol.StatusIdle}); err != nil {
		t.Fatal(err)
	}
	s.waitLog(t, "hook_thread_unbound")
	if err := Send(context.Background(), []string{s.path}, Message{Session: "ac-abc123", Thread: strings.Repeat("a", 128), Status: protocol.StatusIdle}); err != nil {
		t.Fatal(err)
	}
	if got := s.reporter.wait(t, 1); len(got) != 1 || got[0].status != protocol.StatusIdle {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(s.logText(), "hook_message_rejected") {
		t.Fatalf("log: %s", s.logText())
	}
}
