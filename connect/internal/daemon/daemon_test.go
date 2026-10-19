package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

const requestID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

func TestSnapshotOnConnectAndReconnectAfterDrop(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	first := server.nextStream(t)
	sessions := server.waitEvent(t, isType(protocol.EventSessions)).(*protocol.SessionsEvent)
	if len(sessions.Sessions) != 0 {
		t.Fatalf("sessions: %+v", sessions.Sessions)
	}
	if h.updater.count() != 1 || h.updater.calls[0] != [2]string{"1.2.4", "1.0.0"} {
		t.Fatalf("updater: %v", h.updater.calls)
	}
	first.drop()
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventSessions))
	if !strings.Contains(h.notices.String(), "reconnecting") {
		t.Errorf("notices: %q", h.notices.String())
	}
	h.stop(t)
}

func TestRevokedWhenStreamIsUnauthorized(t *testing.T) {
	server := newFakeServer(t)
	server.streamRefusal = &refusal{http.StatusUnauthorized, protocol.CodeUnauthorized}
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	if err := h.wait(t); !errors.Is(err, ErrRevoked) {
		t.Fatalf("got %v", err)
	}
	if server.streamOpens.Load() != 1 {
		t.Fatalf("retried after revocation: %d", server.streamOpens.Load())
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
			h := newHarness(t, server, fakeTmux(t), fastTiming())
			h.start()
			stream := server.nextStream(t)
			server.waitEvent(t, isType(protocol.EventSessions))
			tc.send(stream)
			if err := h.wait(t); !errors.Is(err, tc.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestDisabledWaitsAndOutdatedCallsUpdater(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fakeTmux(t), fastTiming())
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
	server.streamRefusal = &refusal{http.StatusForbidden, protocol.CodeDisabled}
	h2 := newHarness(t, server, fakeTmux(t), fastTiming())
	h2.start()
	time.Sleep(200 * time.Millisecond)
	opens := server.streamOpens.Load()
	h2.stop(t)
	if opens < 2 || opens > 12 {
		t.Errorf("disabled retry count: %d", opens)
	}
}

func TestIdleStreamReconnects(t *testing.T) {
	server := newFakeServer(t)
	timing := fastTiming()
	timing.IdleTimeout = 150 * time.Millisecond
	h := newHarness(t, server, fakeTmux(t), timing)
	h.start()
	server.nextStream(t)
	started := time.Now()
	server.nextStream(t)
	if elapsed := time.Since(started); elapsed < 100*time.Millisecond {
		t.Errorf("reconnected after %v", elapsed)
	}
	h.stop(t)
}

func TestUnknownCommandIsAnsweredUnsupported(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "future_command", "requestId": requestID, "extra": 1})
	stream.command(map[string]any{"type": "another_future_command"})
	reply := server.waitEvent(t, replyFor(requestID)).(*protocol.ReplyEvent)
	if reply.OK || reply.Code == nil || *reply.Code != protocol.CodeUnsupported {
		t.Fatalf("reply: %+v", reply)
	}
	h.stop(t)
}

func TestRecentDirsReply(t *testing.T) {
	server := newFakeServer(t)
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "recent_dirs", "requestId": requestID})
	reply := server.waitEvent(t, replyFor(requestID)).(*protocol.ReplyEvent)
	result, err := protocol.DecodeCommandResult(protocol.CommandRecentDirs, reply.Result)
	if err != nil || result.(*protocol.RecentDirsResult).Home != h.daemon.home || len(result.(*protocol.RecentDirsResult).Dirs) != 1 {
		t.Fatalf("result: %s %v", reply.Result, err)
	}
	h.stop(t)
}

func TestEventsRefusalsReconnectOrRevoke(t *testing.T) {
	server := newFakeServer(t)
	server.eventsReplies = []refusal{{http.StatusServiceUnavailable, ""}, {http.StatusConflict, protocol.CodeStreamRequired}}
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	server.nextStream(t)
	// 503 is retried, 409 forces a new stream, whose snapshot then arrives.
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventSessions))
	server.mu.Lock()
	server.eventsReplies = []refusal{{http.StatusUnauthorized, protocol.CodeUnauthorized}}
	server.mu.Unlock()
	h.daemon.current().pushViewClosed("00000000-0000-4000-8000-000000000001", protocol.ViewClosedDetached)
	if err := h.wait(t); !errors.Is(err, ErrRevoked) {
		t.Fatalf("got %v", err)
	}
}

func TestSenderPostsSeriallyWithinLimits(t *testing.T) {
	server := newFakeServer(t)
	server.limits.MaxEventsPerPost = 5
	server.limits.MaxEventsBodyBytes = 2000
	server.eventsDelay = 5 * time.Millisecond
	h := newHarness(t, server, fakeTmux(t), fastTiming())
	h.start()
	server.nextStream(t)
	server.waitEvent(t, isType(protocol.EventSessions))
	conn := h.daemon.current()
	const total = 120
	for i := range total {
		conn.pushViewClosed(fmt.Sprintf("00000000-0000-4000-8000-%012d", i), protocol.ViewClosedDetached)
	}
	for i := range total {
		event := server.waitEvent(t, isType(protocol.EventViewClosed)).(*protocol.ViewClosedEvent)
		if want := fmt.Sprintf("00000000-0000-4000-8000-%012d", i); event.ViewID != want {
			t.Fatalf("order: got %s want %s", event.ViewID, want)
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

func TestOutboxBoundsAndDrops(t *testing.T) {
	o := newOutbox(100)
	if err := o.push(&outItem{data: []byte("a"), viewID: "v", bytes: 60}); err != nil {
		t.Fatal(err)
	}
	if err := o.push(&outItem{data: []byte("b"), viewID: "v", bytes: 60}); !errors.Is(err, errViewOverflow) {
		t.Fatalf("overflow: %v", err)
	}
	o.push(&outItem{data: []byte("s1"), sessions: true})
	o.push(&outItem{data: []byte("x")})
	o.push(&outItem{data: []byte("s2"), sessions: true})
	o.dropView("v")
	if err := o.push(&outItem{data: []byte("c"), viewID: "v", bytes: 1}); err != nil || o.pending() != 2 {
		t.Fatalf("after drop: %v %d", err, o.pending())
	}
	batch := o.take(context.Background(), 10, 1000)
	if len(batch) != 2 || string(batch[0].data) != "x" || string(batch[1].data) != "s2" {
		t.Fatalf("batch: %q %q", batch[0].data, batch[1].data)
	}
	o.push(&outItem{data: []byte(strings.Repeat("y", 50))})
	o.push(&outItem{data: []byte(strings.Repeat("z", 50))})
	if batch := o.take(context.Background(), 10, 80); len(batch) != 1 {
		t.Fatalf("byte bound: %d", len(batch))
	}
}
