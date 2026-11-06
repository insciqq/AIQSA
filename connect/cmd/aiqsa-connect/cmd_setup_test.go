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
)

// fakeHome gives setup a temporary home; nothing reaches the real agents.
func fakeHome(t *testing.T) string {
	t.Helper()
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func runSetupArgs(stdin string, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(&invocation{ctx: context.Background(), args: append([]string{"setup"}, args...), stdin: strings.NewReader(stdin), stdout: &stdout, stderr: &stderr})
	return code, stdout.String(), stderr.String()
}

// The hooks an earlier, terminal version added.
const (
	oldClaudeSettings = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/aiqsa-connect hook claude",
            "async": true
          }
        ]
      }
    ]
  }
}
`
	oldCodexHooks = `{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/aiqsa-connect hook codex",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
`
)

func writeHookFiles(t *testing.T, home string) (claudeFile, codexFile string) {
	t.Helper()
	claudeFile = hooks.DefaultFile(home, hooks.AgentClaude)
	codexFile = hooks.DefaultFile(home, hooks.AgentCodex)
	for path, content := range map[string]string{claudeFile: oldClaudeSettings, codexFile: oldCodexHooks} {
		os.MkdirAll(filepath.Dir(path), 0o700)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return claudeFile, codexFile
}

func TestSetupWithoutRemoveHasNothingToDo(t *testing.T) {
	home := fakeHome(t)
	claudeFile, _ := writeHookFiles(t, home)
	code, stdout, _ := runSetupArgs("")
	if code != 0 || !strings.Contains(stdout, "nothing to set up") || !strings.Contains(stdout, "setup --remove") {
		t.Fatalf("setup: %d %q", code, stdout)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != oldClaudeSettings {
		t.Fatal("plain setup changed a hook file")
	}
	if code, _, _ := runSetupArgs("", "extra"); code != 2 {
		t.Fatalf("extra argument: %d", code)
	}
}

func TestSetupRemoveAsksThenRemovesTheOldHooks(t *testing.T) {
	home := fakeHome(t)
	claudeFile, codexFile := writeHookFiles(t, home)

	code, stdout, _ := runSetupArgs("n\n", "--remove")
	if code != 1 || !strings.Contains(stdout, "Nothing was changed.") || !strings.Contains(stdout, "[y/N]") ||
		!strings.Contains(stdout, claudeFile+" (a copy is kept at "+claudeFile+hooks.BackupSuffix+")") ||
		!strings.Contains(stdout, codexFile+" (it holds only these hooks, so it is deleted)") {
		t.Fatalf("declined: %d %q", code, stdout)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != oldClaudeSettings {
		t.Fatal("declined removal wrote the file")
	}

	code, stdout, stderr := runSetupArgs("y\n", "--remove")
	if code != 0 || !strings.Contains(stdout, "Hooks removed.") {
		t.Fatalf("accepted: %d %q %q", code, stdout, stderr)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != "{\n  \"model\": \"opus\"\n}\n" {
		t.Fatalf("claude file: %q", data)
	}
	if _, err := os.Stat(codexFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the file holding only the old hooks stayed")
	}
	if code, stdout, _ := runSetupArgs("", "--remove"); code != 0 || !strings.Contains(stdout, "No AIQSA Connect hooks") {
		t.Fatalf("repeat remove: %d %q", code, stdout)
	}
}

// A second setup while the first waits for its answer changes nothing.
func TestSetupRunsOneAtATime(t *testing.T) {
	home := fakeHome(t)
	claudeFile, _ := writeHookFiles(t, home)
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	paths.EnsureStateDir()
	release, err := daemon.AcquireLock(filepath.Join(paths.StateDir, "setup.lock"))
	if err != nil {
		t.Fatal(err)
	}
	code, _, stderr := runSetupArgs("", "--remove", "--yes")
	if code != 1 || !strings.Contains(stderr, "another aiqsa-connect setup is running") {
		t.Fatalf("got %d %q", code, stderr)
	}
	if data, _ := os.ReadFile(claudeFile); string(data) != oldClaudeSettings {
		t.Fatal("a second setup changed the hooks")
	}
	release()
	if code, stdout, stderr := runSetupArgs("", "--remove", "--yes"); code != 0 || !strings.Contains(stdout, "Hooks removed.") {
		t.Fatalf("after the first: %d %q %q", code, stdout, stderr)
	}
}

func TestSetupRemoveRefusesAnUnreadableFile(t *testing.T) {
	home := fakeHome(t)
	_, codexFile := writeHookFiles(t, home)
	claudeFile := hooks.DefaultFile(home, hooks.AgentClaude)
	os.WriteFile(claudeFile, []byte(`{"model": `), 0o600)
	code, _, stderr := runSetupArgs("", "--remove", "--yes")
	if code != 1 || !strings.Contains(stderr, "is not a valid JSON object; nothing was changed") {
		t.Fatalf("broken file: %d %q", code, stderr)
	}
	// Nothing at all was written, not even the other agent's file.
	if data, _ := os.ReadFile(codexFile); string(data) != oldCodexHooks {
		t.Fatal("Codex file changed although setup refused")
	}
}
