package tmux

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Pane is one pane of a tmux server as ListPanes reports it. Text fields
// are raw: they stay on this computer.
type Pane struct {
	PID     int
	Session string
	// Cwd is the working directory of the pane's foreground process.
	Cwd string
	// Program is the session's OptionProgram, empty for a foreign session.
	Program string
}

var paneFields = []string{"#{session_name}", "#{pane_current_path}", "#{" + OptionProgram + "}", "#{pane_pid}"}

// ListPanes lists every pane on the tmux server of socket. It only reads:
// it loads no config and never starts a server, so a hook can call it with
// nothing but the socket name. ErrNoServer means no server runs on that
// socket.
func ListPanes(ctx context.Context, bin, socket string) ([]Pane, error) {
	// A random separator cannot occur in the fields, whatever a path or a
	// foreign session name contains.
	var nonce [8]byte
	rand.Read(nonce[:])
	sep := "|" + hex.EncodeToString(nonce[:]) + "|"
	end := sep + "end"
	cmd := exec.CommandContext(ctx, bin, "-u", "-L", socket, "list-panes", "-a", "-F", strings.Join(paneFields, sep)+end)
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
	var panes []Pane
	for _, record := range strings.Split(stdout.String(), end+"\n") {
		fields := strings.Split(record, sep)
		if len(fields) != len(paneFields) {
			continue
		}
		pid, err := strconv.Atoi(fields[3])
		if err != nil || pid <= 1 || fields[0] == "" {
			continue
		}
		panes = append(panes, Pane{PID: pid, Session: fields[0], Cwd: fields[1], Program: fields[2]})
	}
	return panes, nil
}
