package main

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "sessions",
		usage:   "sessions",
		summary: "List this computer's AIQSA Connect sessions",
		run:     runSessions,
	})
}

func localManager() (*tmux.Manager, error) {
	paths, err := config.ResolvePaths()
	if err != nil {
		return nil, err
	}
	return tmux.New(tmux.Options{Socket: paths.TmuxSocket, ConfigPath: paths.TmuxConfigFile()})
}

func runSessions(inv *invocation) int {
	if len(inv.args) > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect sessions")
		return 2
	}
	manager, err := localManager()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect sessions: %v\n", err)
		return 1
	}
	list, err := manager.List(inv.ctx)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect sessions: %v\n", err)
		return 1
	}
	home, _ := os.UserHomeDir()
	sessions := daemon.SnapshotSessions(list, home, -1)
	if len(sessions) == 0 {
		fmt.Fprintln(inv.stdout, "No sessions.")
		return 0
	}
	w := tabwriter.NewWriter(inv.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tPROGRAM\tSTATUS\tTITLE\tCWD")
	for _, s := range sessions {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", s.ID, daemon.ProgramLabel(s.Program), statusLabel(s.Status), s.Title, s.Cwd)
	}
	w.Flush()
	return 0
}

func statusLabel(status protocol.SessionStatus) string {
	switch status {
	case protocol.StatusRunning:
		return "running"
	case protocol.StatusNeedsApproval:
		return "needs approval"
	case protocol.StatusWaiting:
		return "your turn"
	}
	return "idle"
}
