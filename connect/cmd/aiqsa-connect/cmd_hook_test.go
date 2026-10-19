package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

// shortStateDir points the client at a state directory short enough for
// its socket path.
func shortStateDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ach")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv(config.EnvStateDir, dir)
	return dir
}

func runHookArgs(stdin io.Reader, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(&invocation{ctx: context.Background(), args: append([]string{"hook"}, args...), stdin: stdin, stdout: &stdout, stderr: &stderr})
	return code, stdout.String(), stderr.String()
}

func TestHookIsSilentAndExitsZeroOutsideASessionAndWithoutADaemon(t *testing.T) {
	isolate(t)
	shortStateDir(t)
	t.Setenv(sessionEnv, "")
	payload := `{"hook_event_name":"Notification","notification_type":"permission_prompt"}`
	for _, args := range [][]string{{"claude"}, {"codex"}, {"bell"}, {"bell", "../x"}, {}, {"other"}, {"claude", "a", "b"}} {
		if code, stdout, stderr := runHookArgs(strings.NewReader(payload), args...); code != 0 || stdout != "" || stderr != "" {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	// In a session with no daemon listening: still nothing, quickly.
	t.Setenv(sessionEnv, "ac-abc123")
	start := time.Now()
	for _, args := range [][]string{{"claude"}, {"codex"}, {"bell", "ac-abc123"}} {
		if code, stdout, stderr := runHookArgs(strings.NewReader(payload), args...); code != 0 || stdout != "" || stderr != "" {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("hooks took %v without a daemon", elapsed)
	}
}

// The `up` hook serves the socket for a real daemon (offline: no stream),
// and hooks run in a session change its tmux status.
func TestHooksReportToTheDaemonOfUp(t *testing.T) {
	server := tmuxtest.New(t)
	shortStateDir(t)
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	d, err := daemon.New(daemon.Options{
		Credentials: config.Credentials{Origin: "https://ai.example.com", DeviceID: testDeviceID, DeviceToken: testToken},
		Paths:       paths, Tmux: server.Manager,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := serveHookSocket(ctx, d); err != nil {
		t.Fatal(err)
	}
	id, err := server.Manager.Create(context.Background(), tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: server.Home})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(sessionEnv, id)
	statusOf := func() string {
		value, err := server.Manager.Option(context.Background(), id, tmux.OptionStatus)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	expect := func(want protocol.SessionStatus) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for statusOf() != string(want) {
			if time.Now().After(deadline) {
				t.Fatalf("status %q, want %q", statusOf(), want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	hook := func(stdin string, args ...string) {
		t.Helper()
		if code, stdout, stderr := runHookArgs(strings.NewReader(stdin), args...); code != 0 || stdout != "" || stderr != "" {
			t.Fatalf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	// A prompt and a command are in the input; only the event is used.
	hook(`{"hook_event_name":"UserPromptSubmit","prompt":"deploy it"}`, "claude")
	expect(protocol.StatusRunning)
	hook(`{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}`, "claude")
	expect(protocol.StatusNeedsApproval)
	hook(`{"hook_event_name":"PostToolUse","tool_input":{"command":"ls"},"tool_response":"`+strings.Repeat("x", 3*status.MaxHookInputBytes)+`"}`, "codex")
	expect(protocol.StatusRunning)
	hook(`{"hook_event_name":"Stop","last_assistant_message":"done"}`, "codex")
	expect(protocol.StatusWaiting)
	hook(`{"hook_event_name":"SessionEnd","reason":"other"}`, "claude")
	expect(protocol.StatusIdle)
	// A bell right after a hook status leaves it alone.
	hook("", "bell", id)
	time.Sleep(200 * time.Millisecond)
	expect(protocol.StatusIdle)
}
