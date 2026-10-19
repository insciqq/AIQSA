package localsock

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"slices"
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
		`{"candidate":"ac-abc123","status":"idle"}`,
		`{"session":"ac-abc123","thread":"t1","candidate":"ac-xyz789","status":"idle"}`,
		`{"thread":"t1","candidate":"../x","status":"idle"}`,
		`{"thread":"t1","weak":true,"status":"idle"}`,
		`{"session":"ac-abc123","thread":"t1","status":"waiting","reason":"bell"}`,
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

// applier is a server whose messages the test applies itself, one at a
// time and in order, without connections.
func applier(t *testing.T) (*Server, *fakeReporter) {
	t.Helper()
	reporter := newFakeReporter()
	server, err := Listen([]string{shortDir(t) + "/daemon.sock"}, reporter, logx.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	return server, reporter
}

func (s *Server) applyMessage(t *testing.T, m Message) {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	s.apply(data)
}

// hookStarts stamps messages with hook starts in event order, before the
// daemon reads its own clock: the i-th millisecond of them.
func hookStarts() func(i int, m Message) Message {
	clock := monoclock.Now()
	base := clock.At - int64(time.Second)
	return func(i int, m Message) Message {
		m.At, m.Clock = base+int64(i)*int64(time.Millisecond), clock.Kind
		return m
	}
}

func expectReports(t *testing.T, reporter *fakeReporter, want ...report) {
	t.Helper()
	if got := reporter.list(); !slices.Equal(got, want) {
		t.Fatalf("reports %+v, want %+v", got, want)
	}
}

const (
	sessionA = "ac-aaaa1111"
	sessionB = "ac-bbbb2222"
)

var (
	running  = Message{Status: protocol.StatusRunning, Reason: protocol.ReasonInput}
	stopped  = Message{Status: protocol.StatusWaiting, Reason: protocol.ReasonTurnEnd}
	approval = Message{Status: protocol.StatusNeedsApproval, Reason: protocol.ReasonPermission}
	ended    = Message{Status: protocol.StatusIdle}
)

func of(m Message, session, thread, candidate string) Message {
	m.Session, m.Thread, m.Candidate = session, thread, candidate
	return m
}

// A thread bound to session A submits a prompt that session B's screen
// also shows: the hook's candidate B never moves the binding.
func TestAPromptShownOnAnotherScreenNeverMovesABoundThread(t *testing.T) {
	s, r := applier(t)
	at := hookStarts()
	s.applyMessage(t, at(1, of(running, sessionA, "t-a", "")))
	s.applyMessage(t, at(2, of(running, "", "t-a", sessionB)))
	s.applyMessage(t, at(3, of(stopped, "", "t-a", "")))
	// A thread that is not bound is bound by its candidate.
	s.applyMessage(t, at(4, of(running, "", "t-u", sessionB)))
	s.applyMessage(t, at(5, of(stopped, "", "t-u", "")))
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusWaiting, protocol.ReasonTurnEnd},
		report{sessionB, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionB, protocol.StatusWaiting, protocol.ReasonTurnEnd},
	)
}

// A candidate found by a short prompt line binds only a session no other
// thread holds; one found by a longer line may still join it (a new
// conversation after /new, or after Codex ended without its SessionEnd).
func TestAWeakCandidateNeverTakesAHeldSession(t *testing.T) {
	s, r := applier(t)
	at := hookStarts()
	weak := func(m Message) Message {
		m.Weak = true
		return m
	}
	s.applyMessage(t, at(1, weak(of(running, "", "t-own", sessionA))))
	s.applyMessage(t, at(2, of(approval, "", "t-own", "")))
	s.applyMessage(t, at(3, weak(of(running, "", "t-foreign", sessionA))))
	s.applyMessage(t, at(4, of(stopped, "", "t-foreign", "")))
	s.applyMessage(t, at(5, of(running, "", "t-new", sessionA)))
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusNeedsApproval, protocol.ReasonPermission},
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
	)
}

// The thread moved from A to B; a hook that started before the move and
// names A arrives late. It changes neither A's status nor the binding.
func TestAStaleReportNeverMovesABinding(t *testing.T) {
	s, r := applier(t)
	at := hookStarts()
	s.applyMessage(t, at(1, of(running, sessionA, "t", "")))
	s.applyMessage(t, at(3, of(running, sessionB, "t", "")))
	s.applyMessage(t, at(2, of(stopped, sessionA, "t", "")))
	if session, _ := s.threads.session("t"); session != sessionB {
		t.Fatalf("bound to %q", session)
	}
	s.applyMessage(t, at(4, of(stopped, "", "t", "")))
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionB, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionB, protocol.StatusWaiting, protocol.ReasonTurnEnd},
	)
}

// SessionEnd drops the thread's binding: resumed in another terminal, the
// conversation no longer changes the session, and a hook of it that started
// before the end and arrives late binds nothing again.
func TestASessionEndUnbindsItsThread(t *testing.T) {
	s, r := applier(t)
	at := hookStarts()
	s.applyMessage(t, at(1, of(running, sessionA, "t", "")))
	s.applyMessage(t, at(3, of(ended, "", "t", "")))
	s.applyMessage(t, at(2, of(stopped, sessionA, "t", "")))
	if _, bound := s.threads.session("t"); bound {
		t.Fatal("the thread of an ended session is bound")
	}
	// `codex resume` in an unrelated terminal.
	s.applyMessage(t, at(4, of(running, "", "t", "")))
	s.applyMessage(t, at(5, of(stopped, "", "t", "")))
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusIdle, ""},
	)
	// Resumed later in a session, its prompt binds it there; what it held
	// is older and changes nothing.
	s.applyMessage(t, at(6, of(running, "", "t", sessionB)))
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusIdle, ""},
		report{sessionB, protocol.StatusRunning, protocol.ReasonInput},
	)
}

// The first prompt's hook looks at the screens for a while; the turn's
// later events reach the daemon first. They are held and applied once the
// prompt binds the thread, so the newest event decides the status.
func TestALateBindingAppliesTheEventsHeldForItsThread(t *testing.T) {
	for _, final := range []Message{stopped, approval} {
		s, r := applier(t)
		at := hookStarts()
		s.applyMessage(t, at(3, of(final, "", "t", "")))
		s.applyMessage(t, at(2, of(running, "", "t", "")))
		// The previous turn's Stop, older than the binding prompt.
		s.applyMessage(t, at(0, of(stopped, "", "t", "")))
		expectReports(t, r)
		s.applyMessage(t, at(1, of(running, "", "t", sessionA)))
		expectReports(t, r,
			report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
			report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
			report{sessionA, final.Status, final.Reason},
		)
		if held := s.threads.take("t"); len(held) != 0 {
			t.Fatalf("still held: %+v", held)
		}
	}
}

func TestHeldReportsAreBoundedAndExpire(t *testing.T) {
	m := newThreads()
	now := time.Unix(1_000, 0)
	m.now = func() time.Time { return now }
	for i := range maxHeldThreads + 6 {
		m.hold(Message{Thread: fmt.Sprintf("t%d", i), Status: protocol.StatusIdle})
		now = now.Add(time.Millisecond)
	}
	if len(m.held) != maxHeldThreads {
		t.Fatalf("held for %d threads", len(m.held))
	}
	if got := m.take("t0"); len(got) != 0 {
		t.Fatalf("the least recently heard thread was kept: %+v", got)
	}
	// Each thread keeps its newest reports, returned in the order they started.
	for i := range maxHeldPerThread + 2 {
		m.hold(Message{Thread: "many", Status: protocol.StatusWaiting, At: int64(100 - i), Clock: monoclock.Wall})
	}
	got := m.take("many")
	if len(got) != maxHeldPerThread || got[0].At != 100-maxHeldPerThread-1 || got[len(got)-1].At != 98 {
		t.Fatalf("held %+v", got)
	}
	m.hold(Message{Thread: "late", Status: protocol.StatusWaiting})
	now = now.Add(heldFor)
	m.hold(Message{Thread: "other", Status: protocol.StatusWaiting})
	if got := m.take("late"); len(got) != 0 {
		t.Fatalf("an expired report was kept: %+v", got)
	}
	if len(m.held) != 1 {
		t.Fatalf("expired threads kept: %d", len(m.held))
	}
}

// During an update the previous version's hooks still run: they stamp
// their start in Unix nanoseconds without naming the clock.
func TestAHookOfThePreviousVersionWithoutAClockIsApplied(t *testing.T) {
	s, r := applier(t)
	now := time.Now().UnixNano()
	for _, line := range []string{
		`{"session":"ac-aaaa1111","status":"running","reason":"input","at":` + fmt.Sprint(now) + `}`,
		// Started earlier: stale on the wall clock.
		`{"session":"ac-aaaa1111","status":"idle","at":` + fmt.Sprint(now-1) + `}`,
		`{"session":"ac-aaaa1111","status":"waiting","reason":"turn_end","at":` + fmt.Sprint(now+1) + `}`,
		// Still invalid: a negative stamp, an unknown clock.
		`{"session":"ac-aaaa1111","status":"idle","at":-5}`,
		`{"session":"ac-aaaa1111","status":"idle","at":` + fmt.Sprint(now+2) + `,"clock":"boot"}`,
	} {
		s.apply([]byte(line))
	}
	expectReports(t, r,
		report{sessionA, protocol.StatusRunning, protocol.ReasonInput},
		report{sessionA, protocol.StatusWaiting, protocol.ReasonTurnEnd},
	)
}
