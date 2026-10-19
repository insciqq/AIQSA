package tmux_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

func TestListPanesListsThePanesOfOneSocketWithRealTmux(t *testing.T) {
	server := tmuxtest.New(t)
	m := server.Manager
	ctx := context.Background()
	if _, err := tmux.ListPanes(ctx, m.Binary(), server.Socket); !errors.Is(err, tmux.ErrNoServer) {
		t.Fatalf("no server: %v", err)
	}
	// A directory whose name holds what a naive separator would split on.
	odd := filepath.Join(server.Home, "a\tb|c d")
	if err := os.Mkdir(odd, 0o700); err != nil {
		t.Fatal(err)
	}
	want := map[int]tmux.Pane{}
	for _, c := range []struct {
		cwd     string
		program protocol.Program
	}{{server.Home, protocol.ProgramShell}, {odd, protocol.ProgramShell}} {
		id, err := m.Create(ctx, tmux.CreateOptions{Program: c.program, Cwd: c.cwd})
		if err != nil {
			t.Fatal(err)
		}
		text, err := m.Display(ctx, id, "#{pane_pid}")
		pid, convErr := strconv.Atoi(text)
		if err != nil || convErr != nil {
			t.Fatalf("pane pid %q: %v %v", text, err, convErr)
		}
		// Codex itself never runs in a test: the option alone marks it.
		program := string(c.program)
		if c.cwd == odd {
			program = string(protocol.ProgramCodex)
			if err := m.SetOptions(ctx, id, tmux.OptionProgram, program); err != nil {
				t.Fatal(err)
			}
		}
		resolved, err := filepath.EvalSymlinks(c.cwd)
		if err != nil {
			t.Fatal(err)
		}
		want[pid] = tmux.Pane{PID: pid, Session: id, Cwd: resolved, Program: program}
	}
	got, err := tmux.ListPanes(ctx, m.Binary(), server.Socket)
	if err != nil || len(got) != len(want) {
		t.Fatalf("panes: %+v %v, want %+v", got, err, want)
	}
	for _, pane := range got {
		w := want[pane.PID]
		// tmux may report the path with or without symlinks resolved.
		if resolved, err := filepath.EvalSymlinks(pane.Cwd); err == nil {
			pane.Cwd = resolved
		}
		if pane != w {
			t.Fatalf("pane %+v, want %+v", pane, w)
		}
	}
	// Another socket name is another server.
	if _, err := tmux.ListPanes(ctx, m.Binary(), server.Socket+"-other"); !errors.Is(err, tmux.ErrNoServer) {
		t.Fatalf("other socket: %v", err)
	}
}
