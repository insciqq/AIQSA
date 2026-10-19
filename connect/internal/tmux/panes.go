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

// maxPaneCaptureBytes bounds what CapturePane reads.
const maxPaneCaptureBytes = 256 << 10

// CapturePane returns the visible screen and the last history lines above
// it of the session's pane on the tmux server of socket, as plain text with
// wrapped lines joined. Like ListPanes it only reads. The text is the
// user's terminal content: it stays in memory on this computer.
func CapturePane(ctx context.Context, bin, socket, session string, history int) (string, error) {
	cmd := exec.CommandContext(ctx, bin, "-u", "-L", socket, "capture-pane", "-p", "-J",
		"-S", "-"+strconv.Itoa(max(history, 0)), "-t", paneTarget(session))
	cmd.Env = Environ()
	var stdout limitedBuffer
	var stderr bytes.Buffer
	stdout.limit = maxPaneCaptureBytes
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 100 * time.Millisecond
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		message := stderr.String()
		switch {
		case strings.Contains(message, "no server running"), strings.Contains(message, "error connecting to"):
			return "", ErrNoServer
		case strings.Contains(message, "can't find"), strings.Contains(message, "no such session"),
			strings.Contains(message, "session not found"):
			return "", ErrSessionNotFound
		}
		return "", &CommandError{Err: err}
	}
	return stdout.String(), nil
}

// limitedBuffer keeps the first limit bytes written to it and discards the
// rest, so a huge capture never fills memory.
type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
