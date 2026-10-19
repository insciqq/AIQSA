package daemon

import (
	"context"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

// With `window-size latest` the window follows the client used last. A view
// that opens, or reports its size again when it comes back on screen, takes
// the window size even when that size did not change.
func TestOpenedOrResizedViewOwnsWindowSizeWithRealTmux(t *testing.T) {
	ts := tmuxtest.New(t)
	server := newFakeServer(t)
	h := newHarness(t, server, ts.Manager, fastTiming())
	ctx := context.Background()
	id, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	h.start()
	stream := server.nextStream(t)
	windowSize := func(want string) {
		t.Helper()
		waitFor(t, "window size "+want, func() bool {
			size, _ := ts.Manager.Display(ctx, id, "#{window_width}x#{window_height}")
			return size == want
		})
	}

	// A desktop-sized view, then a phone-sized one.
	stream.command(map[string]any{"type": "view_open", "viewId": viewA, "sessionId": id, "cols": 160, "rows": 48})
	server.waitUntil(t, "desktop output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewA) != "" })
	windowSize("160x48")
	stream.command(map[string]any{"type": "view_open", "viewId": viewB, "sessionId": id, "cols": 50, "rows": 20})
	server.waitUntil(t, "phone output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewB) != "" })
	windowSize("50x20")

	// Typing on the desktop gives it the window back.
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "\r"})
	windowSize("160x48")

	// The phone comes back on screen and sends its unchanged size.
	stream.command(map[string]any{"type": "view_resize", "viewId": viewB, "cols": 50, "rows": 20})
	windowSize("50x20")

	// And the desktop tab is shown again.
	stream.command(map[string]any{"type": "view_resize", "viewId": viewA, "cols": 160, "rows": 48})
	windowSize("160x48")

	// A view opened after the desktop was used takes the window at once.
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "\r"})
	stream.command(map[string]any{"type": "view_open", "viewId": viewC, "sessionId": id, "cols": 90, "rows": 30})
	server.waitUntil(t, "third output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewC) != "" })
	windowSize("90x30")
	h.stop(t)
}
