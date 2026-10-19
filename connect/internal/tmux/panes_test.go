package tmux_test

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

func TestPaneSessionsListsThePanesOfOneSocketWithRealTmux(t *testing.T) {
	server := tmuxtest.New(t)
	m := server.Manager
	ctx := context.Background()
	if _, err := tmux.PaneSessions(ctx, m.Binary(), server.Socket); !errors.Is(err, tmux.ErrNoServer) {
		t.Fatalf("no server: %v", err)
	}
	want := map[int]string{}
	for range 2 {
		id, err := m.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: server.Home})
		if err != nil {
			t.Fatal(err)
		}
		text, err := m.Display(ctx, id, "#{pane_pid}")
		pid, convErr := strconv.Atoi(text)
		if err != nil || convErr != nil {
			t.Fatalf("pane pid %q: %v %v", text, err, convErr)
		}
		want[pid] = id
	}
	got, err := tmux.PaneSessions(ctx, m.Binary(), server.Socket)
	if err != nil || len(got) != len(want) {
		t.Fatalf("panes: %v %v, want %v", got, err, want)
	}
	for pid, id := range want {
		if got[pid] != id {
			t.Fatalf("panes: %v, want %v", got, want)
		}
	}
	// Another socket name is another server.
	if _, err := tmux.PaneSessions(ctx, m.Binary(), server.Socket+"-other"); !errors.Is(err, tmux.ErrNoServer) {
		t.Fatalf("other socket: %v", err)
	}
}
