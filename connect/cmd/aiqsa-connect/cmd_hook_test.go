package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/localsock"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/status"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

// runCLIEnv makes the test binary run as aiqsa-connect itself, so a test
// can start a real hook process in a tmux pane.
const runCLIEnv = "AIQSA_CONNECT_TEST_RUN_CLI"

func TestMain(m *testing.M) {
	if os.Getenv(runCLIEnv) == "1" {
		os.Exit(run(&invocation{ctx: context.Background(), args: os.Args[1:], stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr}))
	}
	os.Exit(m.Run())
}

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

type hookReport struct {
	session string
	status  protocol.SessionStatus
	reason  protocol.StatusReason
}

// reportSink is a Reporter that hands every report to the test.
type reportSink chan hookReport

func (r reportSink) ReportStatus(session string, s protocol.SessionStatus, reason protocol.StatusReason) error {
	r <- hookReport{session, s, reason}
	return nil
}

type fakeProcesses map[int]int

func (f fakeProcesses) Parent(pid int) (int, error) {
	if parent, ok := f[pid]; ok {
		return parent, nil
	}
	return 0, errors.New("no such process")
}

func TestAHookWithoutTheSessionEnvironmentTakesItsNearestPanesSession(t *testing.T) {
	// hook's parent 90 (node) -> codex 80 -> pane shell 70 -> tmux server 60 -> 1
	table := fakeProcesses{90: 80, 80: 70, 70: 60, 60: 1}
	cases := []struct {
		name  string
		panes map[int]string
		want  string
	}{
		{"parent is the pane", map[int]string{90: "ac-abc12345"}, "ac-abc12345"},
		{"pane three levels up", map[int]string{70: "ac-abc12345", 5: "ac-zzz99999"}, "ac-abc12345"},
		{"not an ancestor", map[int]string{5: "ac-abc12345"}, ""},
		{"a session the client did not create", map[int]string{70: "main"}, ""},
		{"no panes", map[int]string{}, ""},
	}
	for _, c := range cases {
		if got := sessionOfAncestors(table, 90, c.panes); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	if got := sessionOfAncestors(fakeProcesses{90: 80, 80: 90}, 90, map[int]string{70: "ac-abc12345"}); got != "" {
		t.Fatalf("cycle: %q", got)
	}
}

// An agent may drop HOME too; the hook still finds the default state
// directory, where a daemon with default directories always listens.
func TestHookPathsFindTheHomeWithoutHOME(t *testing.T) {
	u, err := user.Current()
	if err != nil || !filepath.IsAbs(u.HomeDir) {
		t.Skip("no account home directory")
	}
	for _, name := range []string{config.EnvConfigDir, config.EnvStateDir, config.EnvTmuxSocket, "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HOME"} {
		t.Setenv(name, "")
	}
	paths, err := hookPaths()
	if err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(u.HomeDir, ".local", "state", "aiqsa-connect")
	if paths.StateDir != stateDir || paths.TmuxSocket != config.DefaultTmuxSocket {
		t.Fatalf("paths: %+v", paths)
	}
	candidates := localsock.Candidates(paths)
	if candidates[len(candidates)-1] != filepath.Join(stateDir, "daemon.sock") {
		t.Fatalf("candidates: %v", candidates)
	}
}

// Codex starts its hooks without AIQSA_CONNECT_SESSION, TMUX and TMUX_PANE.
// A hook process that descends from a session's pane still reports for
// that session; the same hook anywhere else reports nothing.
func TestHooksWithAScrubbedEnvironmentReportForTheirPane(t *testing.T) {
	server := tmuxtest.New(t)
	stateDir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	reports := make(reportSink, 16)
	sockets, err := localsock.Listen(localsock.Candidates(paths), reports, logx.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() {
		sockets.Serve(ctx)
		close(served)
	}()
	t.Cleanup(func() {
		cancel()
		<-served
	})
	id, err := server.Manager.Create(context.Background(), tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: server.Home})
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil || strings.Contains(exe, "'") {
		t.Skipf("test binary path %q: %v", exe, err)
	}
	// The pane shell runs a script that runs the hook: the hook is below
	// the pane and has none of the session's variables.
	script := filepath.Join(stateDir, "hook.sh")
	scriptText := "env -u " + sessionEnv + " -u TMUX -u TMUX_PANE " + runCLIEnv + "=1 '" + exe + "' hook codex < \"$1\"\nexit 0\n"
	if err := os.WriteFile(script, []byte(scriptText), 0o700); err != nil {
		t.Fatal(err)
	}
	payload := func(name, text string) string {
		path := filepath.Join(stateDir, name)
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	typeInPane := func(line string) {
		t.Helper()
		for _, keys := range [][]string{{"-l", line}, {"Enter"}} {
			cmd := exec.Command(server.Manager.Binary(), append([]string{"-u", "-L", server.Socket, "send-keys", "-t", "=" + id + ":"}, keys...)...)
			cmd.Env = tmux.Environ()
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("send-keys: %v %s", err, out)
			}
		}
	}
	expect := func(want hookReport) {
		t.Helper()
		select {
		case got := <-reports:
			if got != want {
				t.Fatalf("report %+v, want %+v", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("no report, want %+v", want)
		}
	}
	prompt := payload("prompt.json", `{"session_id":"x","turn_id":"y","cwd":"/","hook_event_name":"UserPromptSubmit","model":"m","permission_mode":"default","prompt":"deploy it"}`)
	stop := payload("stop.json", `{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"done"}`)
	typeInPane("sh '" + script + "' '" + prompt + "'")
	expect(hookReport{id, protocol.StatusRunning, protocol.ReasonInput})
	typeInPane("sh '" + script + "' '" + stop + "'")
	expect(hookReport{id, protocol.StatusWaiting, protocol.ReasonTurnEnd})

	// Outside the panes of the client's tmux server: in this process and in
	// a hook process of its own.
	if code, stdout, stderr := runHookArgs(strings.NewReader(`{"hook_event_name":"UserPromptSubmit"}`), "codex"); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("in process: %d %q %q", code, stdout, stderr)
	}
	cmd := exec.Command("sh", script, prompt)
	cmd.Env = append(os.Environ(), runCLIEnv+"=1")
	if out, err := cmd.CombinedOutput(); err != nil || len(out) != 0 {
		t.Fatalf("outside a pane: %v %q", err, out)
	}
	select {
	case got := <-reports:
		t.Fatalf("a hook outside the panes reported %+v", got)
	case <-time.After(500 * time.Millisecond):
	}
}
