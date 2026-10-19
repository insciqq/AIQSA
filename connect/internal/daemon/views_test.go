package daemon

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

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
	// A loaded machine (the whole module testing in parallel under -race)
	// can take seconds per step: the stream must not go idle meanwhile.
	timing := fastTiming()
	timing.IdleTimeout = 2 * time.Minute
	h := newHarness(t, server, ts.Manager, timing)
	ctx := context.Background()
	id, err := ts.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	h.start()
	stream := server.nextStream(t)
	waitLong := func(what string, done func() bool) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for !done() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	windowSize := func(want string) {
		t.Helper()
		waitLong("window size "+want, func() bool {
			size, _ := ts.Manager.Display(ctx, id, "#{window_width}x#{window_height}")
			return size == want
		})
	}
	// claims is how many times a view has claimed the window. A claim still
	// on its way would undo the next step, so each step waits for its own.
	claims := func(viewID string) uint64 {
		if c := h.daemon.current(); c != nil {
			if v := c.viewByID(viewID); v != nil {
				return v.claimed.Load()
			}
		}
		return 0
	}
	open := func(viewID string, cols, rows int) {
		t.Helper()
		stream.command(map[string]any{"type": "view_open", "viewId": viewID, "sessionId": id, "cols": cols, "rows": rows})
		waitLong("claim of a new view", func() bool { return claims(viewID) > 0 })
	}
	shown := func(viewID string, cols, rows int) {
		t.Helper()
		before := claims(viewID)
		stream.command(map[string]any{"type": "view_resize", "viewId": viewID, "cols": cols, "rows": rows})
		waitLong("claim of a shown view", func() bool { return claims(viewID) > before })
	}
	// typed runs a command typed in a view and waits until the pane shows
	// its output, so tmux has taken the keys from that view's client.
	runs := 0
	typed := func(viewID string) {
		t.Helper()
		runs++
		mark := fmt.Sprintf("typed%d", runs)
		stream.command(map[string]any{"type": "view_input", "viewId": viewID, "data": "echo " + mark + "$((6*7))\r"})
		waitLong(mark, func() bool {
			pane, _ := ts.Manager.CaptureHistory(ctx, id)
			return strings.Contains(pane, mark+"42")
		})
	}

	// A desktop-sized view, then a phone-sized one.
	open(viewA, 160, 48)
	windowSize("160x48")
	open(viewB, 50, 20)
	windowSize("50x20")

	// Typing on the desktop gives it the window back.
	typed(viewA)
	windowSize("160x48")

	// The phone comes back on screen and sends its unchanged size.
	shown(viewB, 50, 20)
	windowSize("50x20")

	// And the desktop tab is shown again.
	shown(viewA, 160, 48)
	windowSize("160x48")

	// A view opened after the desktop was used takes the window at once.
	typed(viewA)
	open(viewC, 90, 30)
	windowSize("90x30")
	h.stop(t)
}

// The browser terminal answers tmux's queries when a view attaches, and
// reports mouse and focus: none of that is the user answering the agent.
func TestTerminalRepliesKeepApprovalWithRealTmux(t *testing.T) {
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
	if err := h.daemon.ReportStatus(id, protocol.StatusNeedsApproval, protocol.ReasonPermission); err != nil {
		t.Fatal(err)
	}
	h.start()
	stream := server.nextStream(t)
	stream.command(map[string]any{"type": "view_open", "viewId": viewA, "sessionId": id, "cols": 80, "rows": 24})
	server.waitUntil(t, "first output", func(e []protocol.DeviceEvent) bool { return viewOutput(t, e, viewA) != "" })

	// What xterm.js answers to tmux on attach, split across chunks, then
	// focus and mouse reports.
	for _, data := range []string{
		"\x1b[?1;2c\x1b[>0;276;0c\x1bP>|xterm.js(6.0.0)\x1b\\\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:00",
		"00/0000/0000\x1b\\",
		"\x1b[I\x1b[<64;10;5M\x1b[<0;10;5M\x1b[<0;10;5m\x1b[O",
	} {
		stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": data})
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if v, _ := ts.Manager.Option(ctx, id, tmux.OptionStatus); v != string(protocol.StatusNeedsApproval) {
			t.Fatalf("terminal replies changed the status to %q", v)
		}
		time.Sleep(50 * time.Millisecond)
	}
	events := server.waitUntil(t, "events", func([]protocol.DeviceEvent) bool { return true })
	if n := statusEvents(events, id); n != 0 {
		t.Fatalf("terminal replies sent %d status events", n)
	}

	// The user answers.
	stream.command(map[string]any{"type": "view_input", "viewId": viewA, "data": "y"})
	server.waitUntil(t, "running status", func(e []protocol.DeviceEvent) bool {
		for _, event := range e {
			if s, ok := event.(*protocol.StatusEvent); ok && s.SessionID == id && s.Status == protocol.StatusRunning &&
				s.Reason != nil && *s.Reason == protocol.ReasonInput {
				return true
			}
		}
		return false
	})
	h.stop(t)
}
