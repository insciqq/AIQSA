package daemon

import (
	"context"
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
