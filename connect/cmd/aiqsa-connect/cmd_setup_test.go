package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/hooks"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

const setupTestExe = "/opt/aiqsa/aiqsa-connect"

// fakeSetup gives setup a temporary home, a tmux check, the agents found
// and its own executable path; nothing reaches the real agents.
func fakeSetup(t *testing.T, tmuxErr error, agents map[string]string) string {
	t.Helper()
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	check, find, exe := setupCheckTmux, setupFindAgent, setupExecutable
	t.Cleanup(func() { setupCheckTmux, setupFindAgent, setupExecutable = check, find, exe })
	setupCheckTmux = func() error { return tmuxErr }
	setupFindAgent = func(_ context.Context, name string) (string, bool) {
		path, ok := agents[name]
		return path, ok
	}
	setupExecutable = func() string { return setupTestExe }
	return home
}

func runSetupArgs(stdin string, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(&invocation{ctx: context.Background(), args: append([]string{"setup"}, args...), stdin: strings.NewReader(stdin), stdout: &stdout, stderr: &stderr})
	return code, stdout.String(), stderr.String()
}

func TestSetupAsksThenAddsHooksForTheAgentsFound(t *testing.T) {
	home := fakeSetup(t, nil, map[string]string{"claude": "/home/u/.local/bin/claude", "codex": ""})
	claudeFile := filepath.Join(home, ".claude", "settings.json")
	codexFile := filepath.Join(home, ".codex", "hooks.json")
	os.MkdirAll(filepath.Dir(claudeFile), 0o700)
	original := "{\n  \"model\": \"opus\"\n}\n"
	os.WriteFile(claudeFile, []byte(original), 0o600)

	code, stdout, _ := runSetupArgs("n\n")
	if code != 1 || !strings.Contains(stdout, "Nothing was changed.") || !strings.Contains(stdout, claudeFile+" (a copy is kept at "+claudeFile+hooks.BackupSuffix+")") ||
		!strings.Contains(stdout, codexFile+" (new file)") || !strings.Contains(stdout, "[y/N]") {
		t.Fatalf("declined: %d %q", code, stdout)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != original {
		t.Fatal("declined setup wrote the file")
	}
	if _, err := os.Stat(codexFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("declined setup created the Codex file")
	}

	code, stdout, stderr := runSetupArgs("y\n")
	if code != 0 || !strings.Contains(stdout, "Hooks added.") {
		t.Fatalf("accepted: %d %q %q", code, stdout, stderr)
	}
	for _, want := range []string{
		"tmux: ok", "Claude Code: /home/u/.local/bin/claude", "Codex: found",
		"Sign in to Claude Code and Codex here, at this computer",
		"trust the AIQSA Connect hook in /hooks",
		"AIQSA Settings → Connected apps and sign in to MCP there",
		"aiqsa-connect service install (or run aiqsa-connect up)",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("output lacks %q:\n%s", want, stdout)
		}
	}
	claude, _ := os.ReadFile(claudeFile)
	codex, _ := os.ReadFile(codexFile)
	if !strings.Contains(string(claude), setupTestExe+" hook claude") || !strings.Contains(string(codex), setupTestExe+" hook codex") {
		t.Fatalf("hooks missing:\n%s\n%s", claude, codex)
	}

	// Again: nothing to do, no question asked.
	if code, stdout, _ := runSetupArgs(""); code != 0 || !strings.Contains(stdout, "already set up") || strings.Contains(stdout, "[y/N]") {
		t.Fatalf("repeat: %d %q", code, stdout)
	}

	if code, stdout, _ := runSetupArgs("", "--remove", "--yes"); code != 0 || !strings.Contains(stdout, "Hooks removed.") {
		t.Fatalf("remove: %d %q", code, stdout)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != original {
		t.Fatalf("remove left %q", data)
	}
	if _, err := os.Stat(codexFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("remove left the file setup created")
	}
	if code, stdout, _ := runSetupArgs("", "--remove"); code != 0 || !strings.Contains(stdout, "No AIQSA Connect hooks") {
		t.Fatalf("repeat remove: %d %q", code, stdout)
	}
}

func TestSetupNamesTheOriginAndSkipsMissingAgents(t *testing.T) {
	home := fakeSetup(t, nil, map[string]string{"claude": "/usr/bin/claude"})
	paths := isolate(t)
	t.Setenv("HOME", home)
	writeCredentials(t, paths, "https://ai.example.com")
	code, stdout, _ := runSetupArgs("", "--yes")
	if code != 0 || !strings.Contains(stdout, "Codex: not found") || strings.Contains(stdout, "/hooks") ||
		!strings.Contains(stdout, "https://ai.example.com/?settings=connected_apps") || !strings.Contains(stdout, "Sign in to Claude Code here") {
		t.Fatalf("got %d %q", code, stdout)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("setup touched the Codex directory without Codex")
	}
}

// A second setup while the first waits for its answer changes nothing.
func TestSetupRunsOneAtATime(t *testing.T) {
	home := fakeSetup(t, nil, map[string]string{"claude": "/usr/bin/claude"})
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	paths.EnsureStateDir()
	release, err := daemon.AcquireLock(filepath.Join(paths.StateDir, "setup.lock"))
	if err != nil {
		t.Fatal(err)
	}
	code, _, stderr := runSetupArgs("", "--yes")
	if code != 1 || !strings.Contains(stderr, "another aiqsa-connect setup is running") {
		t.Fatalf("got %d %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a second setup wrote the hooks")
	}
	release()
	if code, stdout, stderr := runSetupArgs("", "--yes"); code != 0 || !strings.Contains(stdout, "Hooks added.") {
		t.Fatalf("after the first: %d %q %q", code, stdout, stderr)
	}
}

func TestSetupRefusesWithoutTmuxOrWithAnUnreadableFile(t *testing.T) {
	fakeSetup(t, tmux.ErrNotInstalled, map[string]string{"claude": "/usr/bin/claude"})
	if code, _, stderr := runSetupArgs("", "--yes"); code != 1 || !strings.Contains(stderr, "brew install tmux") || !strings.Contains(stderr, "sudo apt install tmux") {
		t.Fatalf("no tmux: %d %q", code, stderr)
	}

	home := fakeSetup(t, nil, map[string]string{"claude": "/usr/bin/claude", "codex": "/usr/bin/codex"})
	claudeFile := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(claudeFile), 0o700)
	os.WriteFile(claudeFile, []byte(`{"model": `), 0o600)
	code, _, stderr := runSetupArgs("", "--yes")
	if code != 1 || !strings.Contains(stderr, "is not a valid JSON object; nothing was changed") {
		t.Fatalf("broken file: %d %q", code, stderr)
	}
	// Nothing at all was written, not even the other agent's file.
	if _, err := os.Stat(filepath.Join(home, ".codex")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Codex file written although setup refused")
	}
	if code, _, stderr := runSetupArgs("", "--remove", "--yes"); code != 1 || !strings.Contains(stderr, "not a valid JSON object") {
		t.Fatalf("broken file remove: %d %q", code, stderr)
	}
	if code, _, _ := runSetupArgs("", "extra"); code != 2 {
		t.Fatalf("extra argument: %d", code)
	}
}
