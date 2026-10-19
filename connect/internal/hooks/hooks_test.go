package hooks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/status"
)

const exe = "/opt/aiqsa/bin/aiqsa-connect"

// claudeSettings is a user settings file as Claude Code writes it (two-space
// indentation, no final newline), with the user's own hooks and settings.
const claudeSettings = `{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Read(~/.zshrc)"
    ],
    "deny": []
  },
  "env": {
    "PATH_NOTE": "café <literal>",
    "BIG": 1.50e3
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_FILE\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/bin/guard.sh"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}`

const codexHooks = `{
    "description": "my hooks",
    "hooks": {
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "say done",
                        "timeout": 10
                    }
                ]
            }
        ]
    }
}
`

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func mustInstall(t *testing.T, path string, agent status.Agent) *Plan {
	t.Helper()
	plan, err := PlanInstall(path, exe, agent)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Apply(); err != nil {
		t.Fatal(err)
	}
	return plan
}

func mustRemove(t *testing.T, path string) *Plan {
	t.Helper()
	plan, err := PlanRemove(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Apply(); err != nil {
		t.Fatal(err)
	}
	return plan
}

type handler struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
	Async   bool   `json:"async"`
}

type group struct {
	Matcher string    `json:"matcher"`
	Hooks   []handler `json:"hooks"`
}

func decodeHooks(t *testing.T, content string) map[string][]group {
	t.Helper()
	var file struct {
		Hooks map[string][]group `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(content), &file); err != nil {
		t.Fatalf("%v\n%s", err, content)
	}
	return file.Hooks
}

func TestClaudeInstallKeepsTheUserSettingsAndRemoveRestoresThem(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".claude", "settings.json")
	writeFile(t, path, claudeSettings)
	plan := mustInstall(t, path, status.AgentClaude)
	if !plan.Changed || !plan.Exists {
		t.Fatalf("plan: %+v", plan)
	}
	after := readFile(t, path)
	// The user's lines are unchanged, in place and with their own spelling.
	for _, line := range strings.Split(claudeSettings, "\n") {
		if !strings.Contains(after, line) {
			t.Errorf("lost line %q", line)
		}
	}
	if strings.HasSuffix(after, "\n") {
		t.Error("a final newline was added")
	}
	if !strings.HasPrefix(after, `{
  "model": "opus",`) || !strings.HasSuffix(after, `  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}`) {
		t.Errorf("order changed:\n%s", after)
	}
	hooks := decodeHooks(t, after)
	command := exe + " hook claude"
	want := map[string]group{
		"UserPromptSubmit": {Hooks: []handler{{Type: "command", Command: command, Async: true}}},
		"PostToolUse":      {Hooks: []handler{{Type: "command", Command: command, Async: true}}},
		"Notification":     {Matcher: "permission_prompt|idle_prompt|agent_needs_input", Hooks: []handler{{Type: "command", Command: command, Async: true}}},
		"Stop":             {Hooks: []handler{{Type: "command", Command: command, Async: true}}},
		"SessionEnd":       {Hooks: []handler{{Type: "command", Command: command}}},
	}
	for event, g := range want {
		groups := hooks[event]
		last := groups[len(groups)-1]
		if last.Matcher != g.Matcher || len(last.Hooks) != 1 || last.Hooks[0] != g.Hooks[0] {
			t.Errorf("%s: %+v", event, groups)
		}
	}
	if len(hooks["PostToolUse"]) != 2 || hooks["PostToolUse"][0].Matcher != "Edit|Write" || len(hooks["PreToolUse"]) != 1 {
		t.Errorf("user hooks changed: %+v", hooks)
	}
	if got := readFile(t, plan.Backup()); got != claudeSettings {
		t.Fatalf("backup: %q", got)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o644 {
		t.Errorf("mode changed: %v", info.Mode())
	}

	// A second run changes nothing.
	again, err := PlanInstall(path, exe, status.AgentClaude)
	if err != nil || again.Changed {
		t.Fatalf("repeat: %+v %v", again, err)
	}

	mustRemove(t, path)
	if got := readFile(t, path); got != claudeSettings {
		t.Fatalf("remove did not restore the file:\n%s", got)
	}
	if again, err := PlanRemove(path); err != nil || again.Changed {
		t.Fatalf("repeat remove: %+v %v", again, err)
	}
}

func TestCodexInstallUsesTheFileIndentationAndTimeouts(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".codex", "hooks.json")
	writeFile(t, path, codexHooks)
	mustInstall(t, path, status.AgentCodex)
	after := readFile(t, path)
	if !strings.Contains(after, "\n        \"PermissionRequest\": [\n            {\n                \"hooks\": [") {
		t.Errorf("indentation not kept:\n%s", after)
	}
	if !strings.HasSuffix(after, "}\n") {
		t.Error("final newline lost")
	}
	hooks := decodeHooks(t, after)
	command := exe + " hook codex"
	for _, event := range []string{"UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop"} {
		groups := hooks[event]
		if h := groups[len(groups)-1].Hooks; len(h) != 1 || h[0] != (handler{Type: "command", Command: command, Timeout: 5, Async: true}) {
			t.Errorf("%s: %+v", event, groups)
		}
	}
	if h := hooks["SessionEnd"][0].Hooks[0]; h != (handler{Type: "command", Command: command, Timeout: 3}) {
		t.Errorf("SessionEnd: %+v", h)
	}
	if len(hooks["Stop"]) != 2 || hooks["Stop"][0].Hooks[0].Command != "say done" {
		t.Errorf("user hook lost: %+v", hooks["Stop"])
	}
	mustRemove(t, path)
	if got := readFile(t, path); got != codexHooks {
		t.Fatalf("remove did not restore the file:\n%s", got)
	}
}

func TestAMissingFileIsCreatedAndRemovedAgain(t *testing.T) {
	home := t.TempDir()
	path := DefaultFile(home, status.AgentCodex)
	if path != filepath.Join(home, ".codex", "hooks.json") || DefaultFile(home, status.AgentClaude) != filepath.Join(home, ".claude", "settings.json") {
		t.Fatalf("default files: %s", path)
	}
	plan := mustInstall(t, path, status.AgentCodex)
	if plan.Exists || !plan.Changed {
		t.Fatalf("plan: %+v", plan)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("created file: %v %v", info, err)
	}
	if _, err := os.Stat(plan.Backup()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup of a missing file: %v", err)
	}
	removal := mustRemove(t, path)
	if !removal.Delete {
		t.Fatalf("removal: %+v", removal)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created file left behind: %v", err)
	}
}

func TestTheBackupIsTakenOnceAndAnEmptiedFileIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, "{}\n")
	plan := mustInstall(t, path, status.AgentClaude)
	mustRemove(t, path)
	if got := readFile(t, path); got != "{}\n" {
		t.Fatalf("after remove: %q", got)
	}
	writeFile(t, path, `{"model": "sonnet"}`)
	mustInstall(t, path, status.AgentClaude)
	if got := readFile(t, plan.Backup()); got != "{}\n" {
		t.Fatalf("backup overwritten: %q", got)
	}
	mustRemove(t, path)
	// A compact file comes back indented: the recorded formatting change.
	if got := readFile(t, path); got != "{\n  \"model\": \"sonnet\"\n}" {
		t.Fatalf("after remove: %q", got)
	}
}

func TestInvalidFilesAreRefusedWithoutWriting(t *testing.T) {
	for name, content := range map[string]string{
		"syntax":     `{"model": "opus",}`,
		"comments":   "{\n  // note\n  \"model\": \"opus\"\n}",
		"array":      `[]`,
		"trailing":   `{} {}`,
		"hooks-type": `{"hooks": []}`,
		"event-type": `{"hooks": {"Stop": {"hooks": []}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			writeFile(t, path, content)
			var unreadable *ErrUnreadable
			if _, err := PlanInstall(path, exe, status.AgentClaude); !errors.As(err, &unreadable) || !strings.Contains(err.Error(), "nothing was changed") {
				t.Fatalf("install: %v", err)
			}
			if _, err := PlanRemove(path); !errors.As(err, &unreadable) {
				t.Fatalf("remove: %v", err)
			}
			if got := readFile(t, path); got != content {
				t.Fatalf("file changed: %q", got)
			}
			if _, err := os.Stat(path + BackupSuffix); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("backup written")
			}
		})
	}
}

func TestEntriesFromAnotherLocationAreReplacedAndMixedGroupsKeepTheirOtherHooks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          },
          {
            "type": "command",
            "command": "'/old place/aiqsa-connect' hook claude",
            "async": true
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/aiqsa-connect-linux-amd64 hook claude"
          }
        ]
      }
    ]
  }
}`)
	mustInstall(t, path, status.AgentClaude)
	hooks := decodeHooks(t, readFile(t, path))
	if _, ok := hooks["SessionStart"]; ok {
		t.Errorf("an old entry in another event stayed: %+v", hooks["SessionStart"])
	}
	stop := hooks["Stop"]
	if len(stop) != 2 || len(stop[0].Hooks) != 1 || stop[0].Hooks[0].Command != "say done" || stop[1].Hooks[0].Command != exe+" hook claude" {
		t.Fatalf("Stop: %+v", stop)
	}
	mustRemove(t, path)
	hooks = decodeHooks(t, readFile(t, path))
	if len(hooks) != 1 || len(hooks["Stop"]) != 1 || hooks["Stop"][0].Hooks[0].Command != "say done" {
		t.Fatalf("after remove: %+v", hooks)
	}
}

func TestCommandsAreQuotedAndRecognized(t *testing.T) {
	if got := Command("/Users/a b/it's/aiqsa-connect", status.AgentCodex); got != `'/Users/a b/it'\''s/aiqsa-connect' hook codex` {
		t.Fatalf("quoted: %s", got)
	}
	for command, own := range map[string]bool{
		exe + " hook claude":                                true,
		Command("/Users/a b/it's/aiqsa-connect", "codex"):   true,
		"/home/u/dist/aiqsa-connect hook codex":             true,
		"/home/u/aiqsa-connect hook bell ac-abc123":         false,
		"/home/u/aiqsa-connect hook claude; rm -rf ~":       false,
		"/home/u/other-tool hook claude":                    false,
		"echo /home/u/aiqsa-connect hook claude":            false,
		"say done":                                          false,
		`"/home/u/aiqsa-connect" hook claude`:               false,
		"/home/u/aiqsa-connect hook claude --extra":         false,
		"/home/u/aiqsa-connect-darwin-arm64 hook claude":    true,
		Command("/tmp/x/aiqsa-connect", status.AgentClaude): true,
		"  /home/u/aiqsa-connect   hook   codex  ":          true,
		"/home/u/aiqsa-connectx/../tool hook claude":        false,
		"/home/u/aiqsa-connect.d/tool hook claude":          false,
		"aiqsa-connect hook claude":                         true,
	} {
		if IsOwnCommand(command) != own {
			t.Errorf("%q: own=%v", command, !own)
		}
	}
}

func TestASymlinkedSettingsFileIsEditedThroughTheLink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "dotfiles", "settings.json")
	writeFile(t, target, claudeSettings)
	link := filepath.Join(dir, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(link), 0o700)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	plan := mustInstall(t, link, status.AgentClaude)
	if info, err := os.Lstat(link); err != nil || info.Mode().Type() != os.ModeSymlink {
		t.Fatalf("link replaced: %v %v", info, err)
	}
	if !strings.Contains(readFile(t, target), "hook claude") || plan.Backup() != target+BackupSuffix {
		t.Fatal("target not edited")
	}
}

// The user can take minutes to confirm setup; a file rewritten meanwhile
// (Claude Code's /config, the user) keeps what it holds now.
func TestReviewPreserveConcurrentSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, `{"model":"old"}`)
	plan, err := PlanInstall(path, exe, status.AgentClaude)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, `{"permissions":{"deny":["Bash(rm *)"]}}`)
	if err := plan.Apply(); err != nil {
		t.Fatal(err)
	}
	got := readFile(t, path)
	if !strings.Contains(got, `"Bash(rm *)"`) || strings.Contains(got, `"old"`) || len(decodeHooks(t, got)) != len(claudeEntries) {
		t.Fatalf("file: %s", got)
	}
	if backup := readFile(t, plan.Backup()); !strings.Contains(backup, `"Bash(rm *)"`) {
		t.Fatalf("backup: %s", backup)
	}
}

func TestReviewPreserveConcurrentSettingsOnRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	mustInstall(t, path, status.AgentClaude)
	plan, err := PlanRemove(path)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Delete {
		t.Fatalf("plan: %+v", plan)
	}
	writeFile(t, path, `{"description":"new user data"}`)
	if err := plan.Apply(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, path); got != `{"description":"new user data"}` {
		t.Fatalf("file: %q", got)
	}
}

func TestAFileCreatedOrBrokenBeforeApplyIsRespected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".codex", "hooks.json")
	plan, err := PlanInstall(path, exe, status.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, `{"note": "mine"}`)
	if err := plan.Apply(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, path); !strings.Contains(got, `"mine"`) || len(decodeHooks(t, got)) != len(codexEntries) {
		t.Fatalf("file: %s", got)
	}
	if backup := readFile(t, plan.Backup()); backup != `{"note": "mine"}` {
		t.Fatalf("backup: %q", backup)
	}

	other := filepath.Join(dir, "settings.json")
	writeFile(t, other, `{"model":"old"}`)
	plan, err = PlanInstall(other, exe, status.AgentClaude)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, other, `{"model":`)
	var unreadable *ErrUnreadable
	if err := plan.Apply(); !errors.As(err, &unreadable) {
		t.Fatalf("broken file: %v", err)
	}
	if got := readFile(t, other); got != `{"model":` {
		t.Fatalf("broken file written: %q", got)
	}
	if _, err := os.Stat(plan.Backup()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup of a broken file: %v", err)
	}
	for _, d := range []string{dir, filepath.Dir(path)} {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			if strings.Contains(e.Name(), ".tmp-") {
				t.Fatalf("temporary file left: %s", e.Name())
			}
		}
	}
}

// Apply never writes over a change that lands between its check and the
// rename: it plans again, and gives up on a file that keeps changing.
func TestAFileThatKeepsChangingIsLeftAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, `{"n": 0}`)
	plan, err := PlanInstall(path, exe, status.AgentClaude)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	beforeReplace = func() {
		n++
		writeFile(t, path, fmt.Sprintf(`{"n": %d}`, n))
	}
	t.Cleanup(func() { beforeReplace = func() {} })
	err = plan.Apply()
	if err == nil || !strings.Contains(err.Error(), "changed since it was read; run aiqsa-connect setup again") {
		t.Fatalf("apply: %v", err)
	}
	if got := readFile(t, path); got != fmt.Sprintf(`{"n": %d}`, n) || n != applyAttempts {
		t.Fatalf("file %q after %d changes", got, n)
	}
}
