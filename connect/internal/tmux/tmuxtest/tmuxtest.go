// Package tmuxtest gives tests their own tmux server: a unique socket name
// in a private TMUX_TMPDIR, killed when the test ends. It never touches the
// user's tmux servers or the client's real socket.
package tmuxtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// Server is a disposable tmux server for one test.
type Server struct {
	Manager  *tmux.Manager
	Socket   string
	StateDir string
	Home     string
}

// New skips the test when tmux is missing; otherwise it sets TMUX_TMPDIR,
// HOME and the client's directory overrides for the test and returns a
// Manager for a fresh socket. Tests using it must not run in parallel.
func New(t *testing.T) *Server {
	t.Helper()
	bin, err := tmux.FindBinary()
	if err != nil {
		t.Skip("tmux is not installed")
	}
	if err := tmux.CheckVersion(bin); err != nil {
		t.Skip("tmux 3.2 or newer is required")
	}
	// Unix socket paths are short; t.TempDir() names can exceed the limit.
	tmpdir, err := os.MkdirTemp("", "act")
	if err != nil {
		t.Fatal(err)
	}
	var raw [6]byte
	rand.Read(raw[:])
	socket := "aiqsa-connect-test-" + hex.EncodeToString(raw[:])
	home := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", tmpdir)
	t.Setenv("TMUX", "")
	t.Setenv("HOME", home)
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("ENV", "")
	t.Setenv("AIQSA_CONNECT_TMUX_SOCKET", socket)
	t.Setenv("AIQSA_CONNECT_STATE_DIR", stateDir)
	t.Setenv("AIQSA_CONNECT_CONFIG_DIR", filepath.Join(t.TempDir(), "config"))
	manager, err := tmux.New(tmux.Options{Binary: bin, Socket: socket, ConfigPath: filepath.Join(stateDir, "tmux.conf")})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.WriteConfig(context.Background(), tmux.ConfigOptions{Shell: "/bin/sh", DefaultTerminal: tmux.DetectTerminal()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd := exec.Command(bin, "-L", socket, "kill-server")
		cmd.Env = append(os.Environ(), "TMUX_TMPDIR="+tmpdir)
		cmd.Run()
		os.RemoveAll(tmpdir)
	})
	return &Server{Manager: manager, Socket: socket, StateDir: stateDir, Home: home}
}
