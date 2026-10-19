package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/localsock"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/monoclock"
	"github.com/insciqq/AIQSA/connect/internal/procs"
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

// A hook stamps its start on this computer's own clock (monotonic where
// there is one), which the daemon orders reports by.
func TestAHookStampsItsStartOnTheComputersClock(t *testing.T) {
	isolate(t)
	shortStateDir(t)
	t.Setenv(sessionEnv, "ac-abc123")
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", localsock.Candidates(paths)[0])
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	lines := make(chan []byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := io.ReadAll(io.LimitReader(conn, 1024))
		lines <- line
	}()
	before := monoclock.Now()
	if code, stdout, stderr := runHookArgs(strings.NewReader(`{"hook_event_name":"Stop"}`), "claude"); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	after := monoclock.Now()
	var msg localsock.Message
	select {
	case line := <-lines:
		if err := json.Unmarshal(line, &msg); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no message")
	}
	want := monoclock.Wall
	if runtime.GOOS == "linux" {
		want = monoclock.Mono
	}
	started := msg.Started()
	if started.Kind != want || !started.Comparable(before) {
		t.Fatalf("stamp %+v, want kind %s", started, want)
	}
	if want == monoclock.Mono && !(before.At <= started.At && started.At <= after.At) {
		t.Fatalf("stamp %+v not between %+v and %+v", started, before, after)
	}
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
	reports := listenForReports(t)
	id, err := server.Manager.Create(context.Background(), tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: server.Home})
	if err != nil {
		t.Fatal(err)
	}
	exe := testExecutable(t)
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
	prompt := payload("prompt.json", `{"session_id":"x","turn_id":"y","cwd":"/","hook_event_name":"UserPromptSubmit","model":"m","permission_mode":"default","prompt":"deploy it"}`)
	stop := payload("stop.json", `{"session_id":"x","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"done"}`)
	typeInPane(t, server, id, "sh '"+script+"' '"+prompt+"'")
	reports.expect(t, hookReport{id, protocol.StatusRunning, protocol.ReasonInput})
	typeInPane(t, server, id, "sh '"+script+"' '"+stop+"'")
	reports.expect(t, hookReport{id, protocol.StatusWaiting, protocol.ReasonTurnEnd})

	// Outside the panes of the client's tmux server: in this process and in
	// a hook process of its own, for a thread no session bound.
	if code, stdout, stderr := runHookArgs(strings.NewReader(`{"hook_event_name":"UserPromptSubmit"}`), "codex"); code != 0 || stdout != "" || stderr != "" {
		t.Fatalf("in process: %d %q %q", code, stdout, stderr)
	}
	foreign := payload("foreign.json", `{"session_id":"foreign","cwd":"/","hook_event_name":"UserPromptSubmit","prompt":"deploy it"}`)
	cmd := exec.Command("sh", script, foreign)
	cmd.Env = append(os.Environ(), runCLIEnv+"=1")
	if out, err := cmd.CombinedOutput(); err != nil || len(out) != 0 {
		t.Fatalf("outside a pane: %v %q", err, out)
	}
	reports.expectNone(t)
	// The hooks under the pane bound their thread: its hook from anywhere
	// still reports for the session.
	runHookArgs(strings.NewReader(`{"session_id":"x","hook_event_name":"PermissionRequest"}`), "codex")
	reports.expect(t, hookReport{id, protocol.StatusNeedsApproval, protocol.ReasonPermission})
}

// A hook that knows its session from the environment binds its Codex
// thread too; Claude hooks never send one.
func TestACodexHookWithTheSessionEnvironmentBindsItsThread(t *testing.T) {
	tmuxtest.New(t)
	shortStateDir(t)
	reports := listenForReports(t)
	t.Setenv(sessionEnv, "ac-abc12345")
	runHookArgs(strings.NewReader(`{"session_id":"019a-env","hook_event_name":"UserPromptSubmit","prompt":"ok"}`), "codex")
	reports.expect(t, hookReport{"ac-abc12345", protocol.StatusRunning, protocol.ReasonInput})
	runHookArgs(strings.NewReader(`{"session_id":"019a-claude","hook_event_name":"UserPromptSubmit"}`), "claude")
	reports.expect(t, hookReport{"ac-abc12345", protocol.StatusRunning, protocol.ReasonInput})
	t.Setenv(sessionEnv, "")
	runHookArgs(strings.NewReader(`{"session_id":"019a-env","hook_event_name":"Stop"}`), "codex")
	reports.expect(t, hookReport{"ac-abc12345", protocol.StatusWaiting, protocol.ReasonTurnEnd})
	runHookArgs(strings.NewReader(`{"session_id":"019a-claude","hook_event_name":"Stop"}`), "codex")
	runHookArgs(strings.NewReader(`{"session_id":"019a-env","hook_event_name":"Stop"}`), "claude")
	reports.expectNone(t)
}

// listenForReports serves the client's local sockets, as `up` does, and
// hands every report to the test.
func listenForReports(t *testing.T) reportSink {
	t.Helper()
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
	return reports
}

func (r reportSink) expect(t *testing.T, want hookReport) {
	t.Helper()
	select {
	case got := <-r:
		if got != want {
			t.Fatalf("report %+v, want %+v", got, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no report, want %+v", want)
	}
}

func (r reportSink) expectNone(t *testing.T) {
	t.Helper()
	select {
	case got := <-r:
		t.Fatalf("unexpected report %+v", got)
	case <-time.After(500 * time.Millisecond):
	}
}

// testExecutable is this test binary, which runs as aiqsa-connect with
// runCLIEnv set.
func testExecutable(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil || strings.Contains(exe, "'") {
		t.Skipf("test binary path %q: %v", exe, err)
	}
	return exe
}

func typeInPane(t *testing.T, server *tmuxtest.Server, id, line string) {
	t.Helper()
	for _, keys := range [][]string{{"-l", line}, {"Enter"}} {
		sendKeys(t, server, id, keys...)
	}
}

func sendKeys(t *testing.T, server *tmuxtest.Server, id string, keys ...string) {
	t.Helper()
	cmd := exec.Command(server.Manager.Binary(), append([]string{"-u", "-L", server.Socket, "send-keys", "-t", "=" + id + ":"}, keys...)...)
	cmd.Env = tmux.Environ()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("send-keys: %v %s", err, out)
	}
}

func TestCodexSessionsOfCwdAreTheCodexSessionsRunningCodexInIt(t *testing.T) {
	base := t.TempDir()
	work := filepath.Join(base, "work")
	other := filepath.Join(base, "other")
	link := filepath.Join(base, "link")
	for _, dir := range []string{work, other} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(work, link); err != nil {
		t.Fatal(err)
	}
	// Pane 10 runs node -> codex; pane 20 runs codex directly; pane 30's
	// agent has exited; pane 40 is a shell; pane 50 runs claude.
	snapshot := procs.NewSnapshot([]procs.Process{
		{PID: 10, PPID: 2, Name: "sh"}, {PID: 11, PPID: 10, Name: "node"}, {PID: 12, PPID: 11, Name: "codex"},
		{PID: 20, PPID: 2, Name: "sh"}, {PID: 21, PPID: 20, Name: "codex"},
		{PID: 30, PPID: 2, Name: "sh"},
		{PID: 40, PPID: 2, Name: "sh"}, {PID: 41, PPID: 40, Name: "codex"},
		{PID: 50, PPID: 2, Name: "sh"}, {PID: 51, PPID: 50, Name: "codex"},
	})
	codexA := tmux.Pane{PID: 10, Session: "ac-aaaa1111", Cwd: work, Program: "codex"}
	codexB := tmux.Pane{PID: 20, Session: "ac-bbbb2222", Cwd: work, Program: "codex"}
	exited := tmux.Pane{PID: 30, Session: "ac-cccc3333", Cwd: work, Program: "codex"}
	shell := tmux.Pane{PID: 40, Session: "ac-dddd4444", Cwd: work, Program: "shell"}
	claude := tmux.Pane{PID: 50, Session: "ac-eeee5555", Cwd: work, Program: "claude"}
	foreign := tmux.Pane{PID: 20, Session: "main", Cwd: work, Program: "codex"}
	elsewhere := tmux.Pane{PID: 20, Session: "ac-bbbb2222", Cwd: other, Program: "codex"}
	cases := []struct {
		name  string
		panes []tmux.Pane
		cwd   string
		want  []string
	}{
		{"one match", []tmux.Pane{codexA, shell, claude, exited}, work, []string{"ac-aaaa1111"}},
		{"the hook names the directory through a symlink", []tmux.Pane{codexA}, link, []string{"ac-aaaa1111"}},
		{"the pane reports it through a symlink", []tmux.Pane{{PID: 10, Session: "ac-aaaa1111", Cwd: link, Program: "codex"}}, work + "/./", []string{"ac-aaaa1111"}},
		{"two codex sessions in one directory", []tmux.Pane{codexA, codexB}, work, []string{"ac-aaaa1111", "ac-bbbb2222"}},
		{"two panes of one session", []tmux.Pane{codexA, {PID: 12, Session: "ac-aaaa1111", Cwd: work, Program: "codex"}}, work, []string{"ac-aaaa1111"}},
		{"its agent has exited", []tmux.Pane{exited}, work, nil},
		{"shell and claude sessions never count", []tmux.Pane{shell, claude}, work, nil},
		{"a session the client did not create", []tmux.Pane{foreign}, work, nil},
		{"another directory", []tmux.Pane{elsewhere}, work, nil},
		{"a relative pane path", []tmux.Pane{{PID: 10, Session: "ac-aaaa1111", Cwd: "work", Program: "codex"}}, work, nil},
		{"no panes", nil, work, nil},
	}
	for _, c := range cases {
		if got := codexSessionsOfCwd(snapshot, c.panes, c.cwd); !slices.Equal(got, c.want) {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestOnlyTheOneSessionShowingThePromptIsChosen(t *testing.T) {
	key := status.PromptKey("fix the flaky login test")
	screens := func(byLook ...map[string]string) func(context.Context, string) (string, error) {
		look := map[string]int{}
		return func(_ context.Context, session string) (string, error) {
			n := min(look[session], len(byLook)-1)
			look[session]++
			screen, ok := byLook[n][session]
			if !ok {
				return "", tmux.ErrSessionNotFound
			}
			if screen == "error" {
				return "", errors.New("tmux failed")
			}
			return screen, nil
		}
	}
	shown := "› fix the flaky\n  login test\n"
	both := []string{"ac-aaaa1111", "ac-bbbb2222"}
	cases := []struct {
		name    string
		capture func(context.Context, string) (string, error)
		want    string
	}{
		{"one shows it", screens(map[string]string{"ac-aaaa1111": "$ ls", "ac-bbbb2222": shown}), "ac-bbbb2222"},
		{"both show it", screens(map[string]string{"ac-aaaa1111": shown, "ac-bbbb2222": shown}), ""},
		{"none shows it", screens(map[string]string{"ac-aaaa1111": "$ ls", "ac-bbbb2222": "fix the flaky"}), ""},
		{"drawn after the hook started", screens(map[string]string{"ac-aaaa1111": "", "ac-bbbb2222": ""}, map[string]string{"ac-aaaa1111": "", "ac-bbbb2222": ""}, map[string]string{"ac-aaaa1111": shown, "ac-bbbb2222": ""}), "ac-aaaa1111"},
		{"a session that is gone", screens(map[string]string{"ac-bbbb2222": shown}), "ac-bbbb2222"},
		{"a screen that cannot be read", screens(map[string]string{"ac-aaaa1111": "error", "ac-bbbb2222": shown}), ""},
	}
	for _, c := range cases {
		if got := sessionShowingPrompt(context.Background(), both, key, c.capture); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	// A first prompt as short as "hi" binds too, by its own prompt line only.
	short := status.PromptKey("hi")
	hi := "› hi\n\n• Hi! What would you like to work on?\n"
	for name, c := range map[string]struct {
		screens map[string]string
		want    string
	}{
		"its prompt line":         {map[string]string{"ac-aaaa1111": "› high five\n• hi there", "ac-bbbb2222": hi}, "ac-bbbb2222"},
		"both show the same line": {map[string]string{"ac-aaaa1111": hi, "ac-bbbb2222": hi}, ""},
	} {
		if got := sessionShowingPrompt(context.Background(), both, short, screens(c.screens)); got != c.want {
			t.Errorf("short prompt, %s: %q, want %q", name, got, c.want)
		}
	}
	// The search gives up within its bound.
	start := time.Now()
	slow := func(ctx context.Context, _ string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}
	if got := sessionShowingPrompt(context.Background(), both, key, slow); got != "" || time.Since(start) > promptSearchWait+time.Second {
		t.Fatalf("slow capture: %q after %v", got, time.Since(start))
	}
}

// fakeCodex is a stand-in for codex: sleep under the name codex. Codex
// itself never runs.
func fakeCodex(t *testing.T, dir string) string {
	t.Helper()
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	data, err := os.ReadFile(sleep)
	if err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(dir, "bin", "codex")
	if err := os.MkdirAll(filepath.Dir(fake), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fake, data, 0o700); err != nil {
		t.Fatal(err)
	}
	return fake
}

// codexCandidates are the Codex sessions a hook in cwd would consider.
func codexCandidates(ctx context.Context, cwd string) []string {
	scene := lookAround(ctx)
	if scene == nil {
		return nil
	}
	return codexSessionsOfCwd(scene.snapshot, scene.panes, cwd)
}

// startCodexSession creates a Codex session in cwd whose screen shows lines
// and whose pane runs the fake codex, and waits until a hook sees it.
func startCodexSession(t *testing.T, server *tmuxtest.Server, fake, cwd string, lines ...string) string {
	t.Helper()
	ctx := context.Background()
	id, err := server.Manager.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Manager.SetOptions(ctx, id, tmux.OptionProgram, string(protocol.ProgramCodex)); err != nil {
		t.Fatal(err)
	}
	command := ""
	for _, line := range lines {
		command += "echo '" + line + "'; "
	}
	typeInPane(t, server, id, command+"exec '"+fake+"' 600")
	deadline := time.Now().Add(10 * time.Second)
	for !slices.Contains(codexCandidates(ctx, cwd), id) {
		if time.Now().After(deadline) {
			t.Fatal("the fake codex was not found")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return id
}

// A Codex thread elsewhere in the folder of a Codex session (a normal
// terminal, another tmux server, an IDE) calls the same global hook; it
// never changes the session's status.
func TestAForeignCodexThreadInTheFolderOfACodexSessionReportsNothing(t *testing.T) {
	s := tmuxtest.New(t)
	dir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	reports := listenForReports(t)
	startCodexSession(t, s, fakeCodex(t, dir), s.Home)
	payload := `{"session_id":"foreign-terminal-thread","cwd":` + strconv.Quote(s.Home) + `,"hook_event_name":"UserPromptSubmit"}`
	runHookArgs(strings.NewReader(payload), "codex")
	reports.expectNone(t)
	// Nor with a prompt the session's screen does not show, nor any later event.
	for _, event := range []string{
		`"hook_event_name":"UserPromptSubmit","prompt":"summarize the release notes"`,
		`"hook_event_name":"PostToolUse"`, `"hook_event_name":"PermissionRequest"`, `"hook_event_name":"Stop"`,
	} {
		runHookArgs(strings.NewReader(`{"session_id":"foreign-terminal-thread","cwd":`+strconv.Quote(s.Home)+`,`+event+`}`), "codex")
	}
	reports.expectNone(t)
}

// Codex 0.163 runs its hooks from a background Codex process outside every
// tmux pane, without the session's environment. A submitted prompt that
// the screen of the one Codex session in the hook's directory shows binds
// the hook's thread to it; later events of that thread report for it, of
// any other thread for none.
func TestAPromptOnACodexSessionsScreenBindsTheHooksThread(t *testing.T) {
	server := tmuxtest.New(t)
	stateDir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	reports := listenForReports(t)
	exe := testExecutable(t)
	work := filepath.Join(server.Home, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	codexID := startCodexSession(t, server, fakeCodex(t, stateDir), work, "fix the flaky login test")
	// A shell session in work never counts.
	if _, err := server.Manager.Create(context.Background(), tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: work}); err != nil {
		t.Fatal(err)
	}
	// The hook is a process of its own, not below any pane, with the
	// environment Codex gives it.
	hook := func(agent, stdin string) {
		t.Helper()
		cmd := exec.Command(exe, "hook", agent)
		cmd.Env = append(os.Environ(), runCLIEnv+"=1")
		cmd.Stdin = strings.NewReader(stdin)
		if out, err := cmd.CombinedOutput(); err != nil || len(out) != 0 {
			t.Fatalf("hook: %v %q", err, out)
		}
	}
	cwd := strconv.Quote(work)
	hook("codex", `{"session_id":"019a-t","turn_id":"y","cwd":`+cwd+`,"hook_event_name":"UserPromptSubmit","model":"m","permission_mode":"default","prompt":"fix the flaky   login test\nand rerun it"}`)
	reports.expect(t, hookReport{codexID, protocol.StatusRunning, protocol.ReasonInput})
	hook("codex", `{"session_id":"019a-t","hook_event_name":"Stop"}`)
	reports.expect(t, hookReport{codexID, protocol.StatusWaiting, protocol.ReasonTurnEnd})
	hook("codex", `{"session_id":"019a-u","hook_event_name":"Stop","cwd":`+cwd+`}`)
	reports.expectNone(t)
	// A Claude hook never binds by its screen.
	hook("claude", `{"session_id":"019a-c","cwd":`+cwd+`,"hook_event_name":"UserPromptSubmit","prompt":"fix the flaky login test"}`)
	reports.expectNone(t)
	// The same prompt from another directory binds nothing.
	hook("codex", `{"session_id":"019a-v","cwd":`+strconv.Quote(server.Home)+`,"hook_event_name":"UserPromptSubmit","prompt":"fix the flaky login test"}`)
	hook("codex", `{"session_id":"019a-v","hook_event_name":"Stop"}`)
	reports.expectNone(t)
}

func TestTwoCodexSessionsInOneFolderAreToldApartByTheirScreens(t *testing.T) {
	server := tmuxtest.New(t)
	stateDir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	reports := listenForReports(t)
	fake := fakeCodex(t, stateDir)
	a := startCodexSession(t, server, fake, server.Home, "alpha: rename the config loader", "shared: bump the version")
	b := startCodexSession(t, server, fake, server.Home, "beta: rename the config writer", "shared: bump the version")
	prompt := func(thread, text string) {
		t.Helper()
		runHookArgs(strings.NewReader(`{"session_id":"`+thread+`","cwd":`+strconv.Quote(server.Home)+`,"hook_event_name":"UserPromptSubmit","prompt":`+strconv.Quote(text)+`}`), "codex")
	}
	prompt("t-a", "rename the config loader")
	reports.expect(t, hookReport{a, protocol.StatusRunning, protocol.ReasonInput})
	prompt("t-b", "rename the config writer")
	reports.expect(t, hookReport{b, protocol.StatusRunning, protocol.ReasonInput})
	// Both screens show it: neither is chosen, and the thread stays unbound.
	prompt("t-both", "bump the version")
	runHookArgs(strings.NewReader(`{"session_id":"t-both","hook_event_name":"Stop"}`), "codex")
	reports.expectNone(t)
	runHookArgs(strings.NewReader(`{"session_id":"t-a","hook_event_name":"Stop"}`), "codex")
	reports.expect(t, hookReport{a, protocol.StatusWaiting, protocol.ReasonTurnEnd})
}

// A bound thread's prompt that only another session's screen shows (the
// user pasted the same text there) leaves the thread where it is bound.
func TestABoundCodexThreadIsNotMovedByAPromptShownOnAnotherScreen(t *testing.T) {
	server := tmuxtest.New(t)
	stateDir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	reports := listenForReports(t)
	fake := fakeCodex(t, stateDir)
	a := startCodexSession(t, server, fake, server.Home, "alpha: rename the config loader")
	startCodexSession(t, server, fake, server.Home, "beta: rename the config writer")
	hook := func(thread, event string) {
		t.Helper()
		runHookArgs(strings.NewReader(`{"session_id":"`+thread+`","cwd":`+strconv.Quote(server.Home)+`,`+event+`}`), "codex")
	}
	hook("t-a", `"hook_event_name":"UserPromptSubmit","prompt":"rename the config loader"`)
	reports.expect(t, hookReport{a, protocol.StatusRunning, protocol.ReasonInput})
	hook("t-a", `"hook_event_name":"UserPromptSubmit","prompt":"rename the config writer"`)
	reports.expect(t, hookReport{a, protocol.StatusRunning, protocol.ReasonInput})
	hook("t-a", `"hook_event_name":"Stop"`)
	reports.expect(t, hookReport{a, protocol.StatusWaiting, protocol.ReasonTurnEnd})
}

// A known limitation, documented in the README: a Codex thread outside the
// client's sessions whose prompt's first line a Codex session in its folder
// already shows, before any thread is bound to that session, binds to it.
func TestAForeignPromptAlreadyShownOnACodexScreenBindsToThatSession(t *testing.T) {
	server := tmuxtest.New(t)
	stateDir := shortStateDir(t)
	t.Setenv(sessionEnv, "")
	reports := listenForReports(t)
	id := startCodexSession(t, server, fakeCodex(t, stateDir), server.Home, "summarize the release notes")
	runHookArgs(strings.NewReader(`{"session_id":"foreign","cwd":`+strconv.Quote(server.Home)+`,"hook_event_name":"UserPromptSubmit","prompt":"summarize the release notes"}`), "codex")
	reports.expect(t, hookReport{id, protocol.StatusRunning, protocol.ReasonInput})
	// Its session's end unbinds it.
	runHookArgs(strings.NewReader(`{"session_id":"foreign","hook_event_name":"SessionEnd"}`), "codex")
	reports.expect(t, hookReport{id, protocol.StatusIdle, ""})
	runHookArgs(strings.NewReader(`{"session_id":"foreign","hook_event_name":"Stop"}`), "codex")
	reports.expectNone(t)
}
