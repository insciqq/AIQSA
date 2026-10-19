package tmux

import (
	"bytes"
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// PaneSessions maps the process id of every pane on the tmux server of
// socket to the name of the pane's session. It only reads: it loads no
// config and never starts a server, so a hook can call it with nothing but
// the socket name. ErrNoServer means no server runs on that socket.
func PaneSessions(ctx context.Context, bin, socket string) (map[int]string, error) {
	cmd := exec.CommandContext(ctx, bin, "-u", "-L", socket, "list-panes", "-a", "-F", "#{pane_pid} #{session_name}")
	cmd.Env = Environ()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 100 * time.Millisecond
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		message := stderr.String()
		if strings.Contains(message, "no server running") || strings.Contains(message, "error connecting to") {
			return nil, ErrNoServer
		}
		return nil, &CommandError{Err: err}
	}
	panes := map[int]string{}
	for line := range strings.SplitSeq(stdout.String(), "\n") {
		pidText, name, ok := strings.Cut(line, " ")
		pid, err := strconv.Atoi(pidText)
		if !ok || err != nil || pid <= 1 || name == "" {
			continue
		}
		panes[pid] = name
	}
	return panes, nil
}
