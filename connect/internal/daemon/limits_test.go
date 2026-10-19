package daemon

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

func TestViewLimitsWithRealTmux(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	server.limits.MaxViews = 1
	timing := fastTiming()
	timing.MaxPendingViewBytes = 4096
	h := newHarness(t, server, ts.Manager, timing)
	ctx := context.Background()
	id, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "view_open", "viewId": viewA, "sessionId": id, "cols": 80, "rows": 24})
	stream.command(map[string]any{"type": "view_open", "viewId": viewB, "sessionId": id, "cols": 80, "rows": 24})
	server.waitUntil(t, "view limit", func(e []protocol.DeviceEvent) bool {
		return closedReason(e, viewB) == protocol.ViewClosedLimit && viewOutput(t, e, viewA) != ""
	})
	// Slow posts let output pile up past the view's bound.
	server.mu.Lock()
	server.eventsDelay = 300 * time.Millisecond
	server.mu.Unlock()
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "head -c 400000 /dev/zero | tr '\\0' x\r"})
	server.waitUntil(t, "backlog limit", func(e []protocol.DeviceEvent) bool { return closedReason(e, viewA) == protocol.ViewClosedLimit })
	if exists, _ := ts.Manager.Exists(ctx, id); !exists {
		t.Fatal("closing a view over its backlog ended the session")
	}
	h.stop(t)
}

// Concurrent session_create requests share one count: a burst at one
// below the limit creates exactly one more session.
func TestReviewConcurrentSessionLimit(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	h := newHarness(t, server, ts.Manager, fastTiming())
	ctx := context.Background()
	limit := server.limits.MaxSessions
	dir := t.TempDir()
	for range limit - 1 {
		if _, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: dir, Title: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	h.start()
	stream := server.nextStream(t)
	var requests []string
	for i := range 8 {
		id := fmt.Sprintf("%08x-2222-4000-8000-%012x", i+1, i+1)
		requests = append(requests, id)
		stream.command(map[string]any{"type": "session_create", "requestId": id, "program": "shell", "cwd": dir})
	}
	events := server.waitUntil(t, "create replies", func(e []protocol.DeviceEvent) bool {
		for _, id := range requests {
			if findReply(e, id) == nil {
				return false
			}
		}
		return true
	})
	created := 0
	for _, id := range requests {
		reply := findReply(events, id)
		switch {
		case reply.OK:
			created++
		case *reply.Code != protocol.CodeSessionLimit:
			t.Fatalf("create %s failed with %s", id, *reply.Code)
		}
	}
	list, err := ts.Manager.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if created != 1 || len(list) != limit {
		t.Fatalf("created %d, %d sessions, limit %d", created, len(list), limit)
	}
	h.stop(t)
}
