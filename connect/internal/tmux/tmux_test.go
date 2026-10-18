package tmux_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

func TestParseVersion(t *testing.T) {
	cases := map[string][2]int{"tmux 3.4\n": {3, 4}, "tmux 3.3a": {3, 3}, "tmux next-3.5": {3, 5}, "tmux 2.9": {2, 9}, "tmux master": {99, 0}}
	for input, want := range cases {
		major, minor, err := tmux.ParseVersion(input)
		if err != nil || major != want[0] || minor != want[1] {
			t.Errorf("ParseVersion(%q) = %d.%d %v", input, major, minor, err)
		}
	}
	if _, _, err := tmux.ParseVersion("something else"); err == nil {
		t.Error("garbage accepted")
	}
}

func TestConfigText(t *testing.T) {
	text := tmux.ConfigText(tmux.ConfigOptions{Shell: "/bin/zsh", DefaultTerminal: "tmux-256color", Executable: "/Users/Jane Doe/.local/bin/aiqsa-connect"})
	for _, line := range []string{
		"set -s escape-time 10", "set -g history-limit 50000", "set -g window-size latest", "set -g mouse on",
		"set -g status off", "set -s extended-keys on", "set -g allow-rename off", "set -g default-terminal tmux-256color",
		"set -g bell-action any", `set -g default-shell "/bin/zsh"`,
		`set-hook -g alert-bell 'run-shell -b "\"/Users/Jane Doe/.local/bin/aiqsa-connect\" hook bell #{q:session_name} >/dev/null 2>&1"'`,
	} {
		if !strings.Contains(text, line+"\n") {
			t.Errorf("missing %q in\n%s", line, text)
		}
	}
	unsafe := tmux.ConfigText(tmux.ConfigOptions{Shell: "/bin/sh\"; x", DefaultTerminal: "other", Executable: "/tmp/a'b/aiqsa-connect"})
	if strings.Contains(unsafe, "default-shell") || strings.Contains(unsafe, "alert-bell") || !strings.Contains(unsafe, "screen-256color") {
		t.Errorf("unsafe paths written:\n%s", unsafe)
	}
	for _, path := range []string{"/a$b", "/a\\b", "/a\nb", "/a#b", "/a;b", "relative", "/a`b`", "/a{b}"} {
		if tmux.SafeConfigPath(path) {
			t.Errorf("SafeConfigPath(%q)", path)
		}
	}
}

func TestArgEscapesTrailingSemicolon(t *testing.T) {
	if tmux.Arg("a;") != `a\;` || tmux.Arg("a;b") != "a;b" || tmux.Arg("") != "" {
		t.Fatal("Arg")
	}
}

func TestNewSessionID(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		id := tmux.NewSessionID()
		if !protocol.SessionIDRegexp.MatchString(id) || len(id) != 11 || seen[id] {
			t.Fatalf("bad id %q", id)
		}
		seen[id] = true
	}
}

func TestResolveCwd(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "proj"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, "file")
	os.WriteFile(file, nil, 0o600)
	for requested, want := range map[string]string{"~": home, "~/proj": filepath.Join(home, "proj"), home + "/proj/../proj/": filepath.Join(home, "proj")} {
		if got, err := tmux.ResolveCwd(requested, home); err != nil || got != want {
			t.Errorf("ResolveCwd(%q) = %q %v", requested, got, err)
		}
	}
	for _, requested := range []string{"~/missing", file, "relative", "~user"} {
		if _, err := tmux.ResolveCwd(requested, home); err == nil {
			t.Errorf("ResolveCwd(%q) accepted", requested)
		}
	}
}

func TestParseOptions(t *testing.T) {
	claude := strings.Join([]string{
		"╭──────────────────────────────────────────╮",
		"│ Bash command                             │",
		"│   git status                             │",
		"╰──────────────────────────────────────────╯",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. Yes, and don't ask again for this command",
		"   3. No, and tell Claude what to do differently (esc)",
		"",
		"",
	}, "\n")
	want := []protocol.SessionOption{
		{Key: "1", Label: "Yes"},
		{Key: "2", Label: "Yes, and don't ask again for this command"},
		{Key: "3", Label: "No, and tell Claude what to do differently (esc)"},
	}
	if got := tmux.ParseOptions(claude); !reflect.DeepEqual(got, want) {
		t.Errorf("claude: %#v", got)
	}
	codex := strings.Join([]string{
		"  Would you like to run the following command?",
		"",
		"  $ ls -la",
		"",
		"› 1. Yes, proceed (y)",
		"  2. Yes, and don't ask again for this command (p)",
		"  3. No, and tell Codex what to do differently (esc)",
		"",
		"  Press enter to confirm or esc to cancel",
	}, "\n")
	want = []protocol.SessionOption{
		{Key: "1", Label: "Yes, proceed (y)"},
		{Key: "2", Label: "Yes, and don't ask again for this command (p)"},
		{Key: "3", Label: "No, and tell Codex what to do differently (esc)"},
	}
	if got := tmux.ParseOptions(codex); !reflect.DeepEqual(got, want) {
		t.Errorf("codex: %#v", got)
	}
	boxed := "│ ❯ 1. Yes                    │\n│   2. Yes, and don't ask again for commands in │\n│      /home/user/a/very/long/project/path │\n│   3. No │\n"
	if got := tmux.ParseOptions(boxed); len(got) != 3 || got[2].Label != "No" {
		t.Errorf("boxed with wrapped label: %#v", got)
	}
	long := "❯ 1. Yes\n  2. " + strings.Repeat("x", 120) + "\n  3. No\n"
	if got := tmux.ParseOptions(long); len(got) != 3 || len([]rune(got[1].Label)) != protocol.MaxOptionLabelLength {
		t.Errorf("long label: %#v", got)
	}
	shell := "user@host:~/project$ ls\nREADME.md  go.mod  main.go\nuser@host:~/project$ echo 1. done\n1. done\nuser@host:~/project$ \n"
	if got := tmux.ParseOptions(shell); len(got) != 0 {
		t.Errorf("shell: %#v", got)
	}
	// An earlier answered menu above a newer one: the last group wins.
	twice := "❯ 1. Old\n  2. Older\n$ next\n› 1. New\n  2. Newer\n"
	if got := tmux.ParseOptions(twice); len(got) != 2 || got[0].Label != "New" {
		t.Errorf("last group: %#v", got)
	}
	broken := "1. a\n3. c\n"
	if got := tmux.ParseOptions(broken); len(got) != 0 {
		t.Errorf("gap: %#v", got)
	}
	result := protocol.SessionOptionsResult{Options: tmux.ParseOptions(claude)}
	if err := result.Validate(); err != nil {
		t.Errorf("result invalid: %v", err)
	}
}

func TestFitHistory(t *testing.T) {
	if got := tmux.FitHistory("a\nb\n\n  \n", 100); got != "a\nb" {
		t.Errorf("trailing blanks: %q", got)
	}
	text := strings.Repeat("line ü\n", 1000)
	got := tmux.FitHistory(text, 100)
	if len(got) > 100 || !strings.HasPrefix(got, "line") || !strings.HasSuffix(got, "line ü") {
		t.Errorf("cut: %q", got)
	}
	if got := tmux.FitHistory("ab\xffc", 10); got != "ab�c" {
		t.Errorf("invalid utf8: %q", got)
	}
	if got := tmux.FitHistory(strings.Repeat("é", 100), 9); len(got) > 9 || !strings.HasPrefix(got, "é") {
		t.Errorf("rune boundary: %q", got)
	}
}

func TestSanitizeText(t *testing.T) {
	if got := tmux.SanitizeText(" a\x1b[31mb\x7f\u0085c\t ", 80); got != "a[31mbc" {
		t.Errorf("got %q", got)
	}
	if got := tmux.SanitizeText(strings.Repeat("ж", 100), 80); len([]rune(got)) != 80 {
		t.Errorf("truncate: %d", len([]rune(got)))
	}
}

func TestSessionsLifecycleWithRealTmux(t *testing.T) {
	server := tmuxtest.New(t)
	m := server.Manager
	ctx := context.Background()
	if sessions, err := m.List(ctx); err != nil || len(sessions) != 0 {
		t.Fatalf("no server: %v %v", sessions, err)
	}
	dir := t.TempDir()
	title := "Title with ; and -x and #{session_name};"
	id, err := m.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: dir, Title: title})
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := m.List(ctx)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("list: %v %v", sessions, err)
	}
	s := sessions[0]
	if s.ID != id || s.Title != title || s.Program != "shell" || s.Status != "idle" || s.CreationCwd != dir || s.Attached != 0 ||
		time.Since(s.Created) > time.Minute || s.StatusAt == "" {
		t.Fatalf("session: %+v", s)
	}
	if env, err := m.Display(ctx, id, "#{session_name}"); err != nil || env != id {
		t.Fatalf("display: %q %v", env, err)
	}
	if err := m.SetOptions(ctx, id, tmux.OptionStatus, "running", tmux.OptionStatusAt, "x;"); err != nil {
		t.Fatal(err)
	}
	if v, err := m.Option(ctx, id, tmux.OptionStatusAt); err != nil || v != "x;" {
		t.Fatalf("option: %q %v", v, err)
	}
	if exists, err := m.Exists(ctx, id); !exists || err != nil {
		t.Fatalf("exists: %v %v", exists, err)
	}
	if exists, _ := m.Exists(ctx, id[:len(id)-1]); exists {
		t.Fatal("prefix matched a session")
	}
	if err := m.Kill(ctx, id[:len(id)-1]); err == nil {
		t.Fatal("prefix kill succeeded")
	}
	if err := m.Kill(ctx, id); err != nil {
		t.Fatal(err)
	}
	if exists, err := m.Exists(ctx, id); exists || err != nil {
		t.Fatalf("after kill: %v %v", exists, err)
	}
	if _, err := m.Option(ctx, id, tmux.OptionTitle); err == nil {
		t.Fatal("option of a killed session")
	}
}

func TestHistoryAndBellHookWithRealTmux(t *testing.T) {
	server := tmuxtest.New(t)
	m := server.Manager
	ctx := context.Background()
	hookDir := t.TempDir()
	marker := filepath.Join(hookDir, "bell.txt")
	script := filepath.Join(hookDir, "fake-client")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$@\" > "+marker+"\necho noise\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.WriteConfig(ctx, tmux.ConfigOptions{Shell: "/bin/sh", DefaultTerminal: "tmux-256color", Executable: script}); err != nil {
		t.Fatal(err)
	}
	id, err := m.Create(ctx, tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: t.TempDir(), Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if out, err := m.Display(ctx, id, "#{escape-time}"); err != nil || out != "10" {
		// escape-time is a server option; display-message expands it.
		t.Fatalf("config not applied: %q %v", out, err)
	}
	send := func(keys ...string) {
		args := append([]string{"-u", "-L", m.Socket(), "send-keys", "-t", "=" + id + ":"}, keys...)
		if err := runTmux(m.Binary(), args...); err != nil {
			t.Fatal(err)
		}
	}
	send("-l", "for i in 1 2 3; do echo history-line-$i; done; printf '\\a'")
	send("Enter")
	deadline := time.Now().Add(10 * time.Second)
	var history string
	for time.Now().Before(deadline) {
		history, _ = m.CaptureHistory(ctx, id)
		if strings.Contains(history, "history-line-3\n") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	fitted := tmux.FitHistory(history, protocol.MaxHistoryBytes)
	if !strings.Contains(fitted, "history-line-1\nhistory-line-2\nhistory-line-3") || strings.HasSuffix(fitted, "\n") {
		t.Fatalf("history: %q", fitted)
	}
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(data)) == "hook bell "+id {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if data, _ := os.ReadFile(marker); strings.TrimSpace(string(data)) != "hook bell "+id {
		t.Fatalf("bell hook: %q", data)
	}
	screen, _ := m.CaptureScreen(ctx, id)
	if strings.Contains(screen, "noise") {
		t.Fatal("hook output reached the pane")
	}
}
