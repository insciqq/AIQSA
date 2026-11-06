package hooks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

// claudeWithOldHooks is claudeSettings after the terminal client's setup.
const claudeWithOldHooks = `{
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
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/bin/aiqsa-connect hook claude",
            "async": true
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
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|agent_needs_input",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/bin/aiqsa-connect hook claude",
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/bin/aiqsa-connect hook claude"
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

const codexWithOldHooks = `{
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
            },
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "'/Users/a b/aiqsa-connect' hook codex",
                        "timeout": 5,
                        "async": true
                    }
                ]
            }
        ],
        "SessionEnd": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "'/Users/a b/aiqsa-connect' hook codex",
                        "timeout": 3
                    }
                ]
            }
        ]
    }
}
`

// onlyOldHooks is a hook file the terminal client created itself.
const onlyOldHooks = `{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/aiqsa/bin/aiqsa-connect hook codex",
            "timeout": 3
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
	if err := os.Chmod(path, 0o644); err != nil {
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

func TestRemoveRestoresTheClaudeSettingsAsTheUserHadThem(t *testing.T) {
	home := t.TempDir()
	path := DefaultFile(home, AgentClaude)
	if path != filepath.Join(home, ".claude", "settings.json") || DefaultFile(home, AgentCodex) != filepath.Join(home, ".codex", "hooks.json") {
		t.Fatalf("default files: %s", path)
	}
	writeFile(t, path, claudeWithOldHooks)
	plan := mustRemove(t, path)
	if !plan.Changed || !plan.Exists || plan.Delete {
		t.Fatalf("plan: %+v", plan)
	}
	if got := readFile(t, path); got != claudeSettings {
		t.Fatalf("remove did not restore the file:\n%s", got)
	}
	if got := readFile(t, plan.Backup()); got != claudeWithOldHooks {
		t.Fatalf("backup: %q", got)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o644 {
		t.Errorf("mode changed: %v", info.Mode())
	}
	if again, err := PlanRemove(path); err != nil || again.Changed {
		t.Fatalf("repeat remove: %+v %v", again, err)
	}
}

func TestRemoveKeepsTheCodexFileIndentation(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".codex", "hooks.json")
	writeFile(t, path, codexWithOldHooks)
	mustRemove(t, path)
	if got := readFile(t, path); got != codexHooks {
		t.Fatalf("remove did not restore the file:\n%s", got)
	}
}

func TestAFileTheClientCreatedIsDeletedAndAMissingOneIsLeftAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".codex", "hooks.json")
	if plan, err := PlanRemove(path); err != nil || plan.Changed || plan.Exists {
		t.Fatalf("missing file: %+v %v", plan, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file created: %v", err)
	}
	writeFile(t, path, onlyOldHooks)
	if removal := mustRemove(t, path); !removal.Delete {
		t.Fatalf("removal: %+v", removal)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created file left behind: %v", err)
	}
	// With a backup of an earlier version, the emptied file stays.
	writeFile(t, path, onlyOldHooks)
	writeFile(t, path+BackupSuffix, "{}\n")
	if removal := mustRemove(t, path); removal.Delete {
		t.Fatalf("removal: %+v", removal)
	}
	if got := readFile(t, path); got != "{}\n" {
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
			if _, err := PlanRemove(path); !errors.As(err, &unreadable) || !strings.Contains(err.Error(), "nothing was changed") {
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

func TestEntriesFromAnyLocationGoAndMixedGroupsKeepTheirOtherHooks(t *testing.T) {
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
	mustRemove(t, path)
	hooks := decodeHooks(t, readFile(t, path))
	if len(hooks) != 1 || len(hooks["Stop"]) != 1 || len(hooks["Stop"][0].Hooks) != 1 || hooks["Stop"][0].Hooks[0].Command != "say done" {
		t.Fatalf("after remove: %+v", hooks)
	}
}

func TestOwnCommandsAreRecognized(t *testing.T) {
	for command, own := range map[string]bool{
		"/opt/aiqsa/bin/aiqsa-connect hook claude":       true,
		`'/Users/a b/it'\''s/aiqsa-connect' hook codex`:  true,
		"/home/u/dist/aiqsa-connect hook codex":          true,
		"/home/u/aiqsa-connect hook bell ac-abc123":      false,
		"/home/u/aiqsa-connect hook claude; rm -rf ~":    false,
		"/home/u/other-tool hook claude":                 false,
		"echo /home/u/aiqsa-connect hook claude":         false,
		"say done":                                       false,
		`"/home/u/aiqsa-connect" hook claude`:            false,
		"/home/u/aiqsa-connect hook claude --extra":      false,
		"/home/u/aiqsa-connect-darwin-arm64 hook claude": true,
		"  /home/u/aiqsa-connect   hook   codex  ":       true,
		"/home/u/aiqsa-connectx/../tool hook claude":     false,
		"/home/u/aiqsa-connect.d/tool hook claude":       false,
		"aiqsa-connect hook claude":                      true,
	} {
		if IsOwnCommand(command) != own {
			t.Errorf("%q: own=%v", command, !own)
		}
	}
}

func TestASymlinkedSettingsFileIsEditedThroughTheLink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "dotfiles", "settings.json")
	writeFile(t, target, claudeWithOldHooks)
	link := filepath.Join(dir, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(link), 0o700)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	plan := mustRemove(t, link)
	if info, err := os.Lstat(link); err != nil || info.Mode().Type() != os.ModeSymlink {
		t.Fatalf("link replaced: %v %v", info, err)
	}
	if readFile(t, target) != claudeSettings || plan.Backup() != target+BackupSuffix {
		t.Fatal("target not edited")
	}
}

// The user can take minutes to confirm; a file rewritten meanwhile (Claude
// Code's /config, the user) keeps what it holds now.
func TestAFileChangedBeforeApplyKeepsItsNewContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, onlyOldHooks)
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

	writeFile(t, path, claudeWithOldHooks)
	if plan, err = PlanRemove(path); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, `{"model":`)
	var unreadable *ErrUnreadable
	if err := plan.Apply(); !errors.As(err, &unreadable) {
		t.Fatalf("broken file: %v", err)
	}
	if got := readFile(t, path); got != `{"model":` {
		t.Fatalf("broken file written: %q", got)
	}
}

// Apply never writes over a change that lands between its check and the
// rename: it plans again, and gives up on a file that keeps changing.
func TestAFileThatKeepsChangingIsLeftAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, claudeWithOldHooks)
	plan, err := PlanRemove(path)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	beforeReplace = func() {
		n++
		writeFile(t, path, strings.Replace(claudeWithOldHooks, `"opus"`, fmt.Sprintf(`"opus-%d"`, n), 1))
	}
	t.Cleanup(func() { beforeReplace = func() {} })
	err = plan.Apply()
	if err == nil || !strings.Contains(err.Error(), "changed since it was read; run aiqsa-connect setup again") {
		t.Fatalf("apply: %v", err)
	}
	if got := readFile(t, path); !strings.Contains(got, fmt.Sprintf(`"opus-%d"`, n)) || n != applyAttempts {
		t.Fatalf("file %q after %d changes", got, n)
	}
}
