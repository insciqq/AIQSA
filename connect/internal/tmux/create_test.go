package tmux_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// A recording stand-in for tmux checks the argument vector of an agent
// session without starting any agent.
func TestCreateTypesTheAgentCommand(t *testing.T) {
	dir := t.TempDir()
	argvFile := filepath.Join(dir, "argv")
	script := filepath.Join(dir, "tmux")
	body := "#!/bin/sh\nif [ \"$1\" = -V ]; then echo 'tmux 3.4'; exit 0; fi\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > " + argvFile + "\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "tmux.conf")
	m, err := tmux.New(tmux.Options{Binary: script, Socket: "aiqsa-connect-test-argv", ConfigPath: config})
	if err != nil {
		t.Fatal(err)
	}
	for _, program := range []protocol.Program{protocol.ProgramClaude, protocol.ProgramCodex} {
		id, err := m.Create(context.Background(), tmux.CreateOptions{Program: program, Cwd: dir + ";", Title: "T;"})
		if err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(argvFile)
		argv := strings.Join(strings.Split(strings.TrimSpace(string(data)), "\n"), " ")
		pane := "=" + id + ":"
		for _, want := range []string{
			"-u -L aiqsa-connect-test-argv -f " + config + " new-session -d -s " + id + " -c " + dir + `\; -e AIQSA_CONNECT_SESSION=` + id + " -x 120 -y 32",
			"; set-option -t " + pane + ` -- @aiqsa_title T\;`,
			"; set-option -t " + pane + " -- @aiqsa_program " + string(program),
			"; set-option -t " + pane + " -- @aiqsa_status idle",
			"; send-keys -t " + pane + " -l " + string(program) + " ; send-keys -t " + pane + " Enter",
		} {
			if !strings.Contains(argv, want) {
				t.Errorf("argv lacks %q:\n%s", want, argv)
			}
		}
	}
}
