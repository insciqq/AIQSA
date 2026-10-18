package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "up",
		usage:   "up",
		summary: "Run the client in the foreground and keep it connected",
		run:     runUp,
	})
}

// Exit statuses of `up`. A service manager must not restart a revoked
// client in a loop, so revocation has its own status.
const (
	exitRevoked = 3
)

// upHooks run after the daemon is created and before it connects, with a
// context that ends when `up` exits. Other commands register them from
// init() (for example the local socket that agent hooks report to). A
// failing hook is reported and `up` continues.
var upHooks []func(ctx context.Context, d *daemon.Daemon) error

// updater is told the server's version after every hello; cmd_update.go
// may replace it from init().
var updater daemon.Updater = daemon.NoopUpdater{}

// selfExecutable is the absolute path the tmux bell hook runs.
func selfExecutable() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	// Linux reports a replaced binary as "<path> (deleted)".
	path = strings.TrimSuffix(path, " (deleted)")
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return path
}

func runUp(inv *invocation) int {
	if len(inv.args) > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect up")
		return 2
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	creds, err := paths.LoadCredentials()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	if err := paths.EnsureStateDir(); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: cannot create the state directory: %v\n", err)
		return 1
	}
	release, err := daemon.AcquireLock(paths.LockFile())
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	defer release()
	log, err := logx.Open(paths.LogFile(), inv.stderr)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: cannot open the log: %v\n", err)
		return 1
	}
	defer log.Close()
	manager, err := tmux.New(tmux.Options{Socket: paths.TmuxSocket, ConfigPath: paths.TmuxConfigFile()})
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	if err := manager.WriteConfig(inv.ctx, tmux.ConfigOptions{
		Shell: tmux.LoginShell(), DefaultTerminal: tmux.DetectTerminal(), Executable: selfExecutable(),
	}); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: cannot write the tmux config: %v\n", err)
		return 1
	}
	d, err := daemon.New(daemon.Options{
		Credentials: creds,
		Paths:       paths,
		Version:     version,
		Tmux:        manager,
		Log:         log,
		Updater:     updater,
		Notices:     inv.stderr,
	})
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithCancel(inv.ctx)
	defer cancel()
	for _, hook := range upHooks {
		if err := hook(ctx, d); err != nil {
			fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		}
	}
	err = d.Run(ctx)
	switch {
	case err == nil:
		return 0
	case errors.Is(err, daemon.ErrRevoked):
		fmt.Fprintln(inv.stderr, "aiqsa-connect: device revoked — run aiqsa-connect login")
		return exitRevoked
	case errors.Is(err, daemon.ErrReplaced):
		fmt.Fprintln(inv.stderr, "aiqsa-connect: another aiqsa-connect process is connected as this device")
		return 0
	}
	fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
	return 1
}
