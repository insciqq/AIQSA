package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "up",
		usage:   "up [--service]",
		summary: "Run the client in the foreground and keep it connected",
		run:     runUp,
	})
}

// exitNoRestart is the status of an interactive `up` that stopped for a
// reason a restart cannot fix: not logged in, revoked, damaged or unreadable
// credentials, or another `up` already running. With --service (the user
// service's command line) `up` exits 0 instead, because launchd's KeepAlive
// cannot exclude a status, and systemd's Restart=on-failure stops at 0 too.
// Other fatal errors exit 1 and are restarted.
const exitNoRestart = 3

// revokedCredentialsFile is where a revoked token is set aside.
const revokedCredentialsFile = "credentials.revoked.json"

const upUsage = "Usage: aiqsa-connect up [--service]"

// serviceLockWait is how long `up --service` waits for another client to
// release the lock before it stops; tests shorten it.
var serviceLockWait = 10 * time.Second

// upStop ends `up` for a reason a restart cannot fix. reason is a log code.
// In service mode the reason also goes to the client's log, because a
// LaunchAgent discards stderr.
func upStop(inv *invocation, serviceMode bool, paths *config.Paths, log *logx.Logger, reason, message string) int {
	fmt.Fprintln(inv.stderr, message)
	if !serviceMode {
		return exitNoRestart
	}
	fmt.Fprintln(inv.stderr, "aiqsa-connect: the service stays stopped; after fixing this, run aiqsa-connect service install.")
	if log == nil && paths != nil && paths.EnsureStateDir() == nil {
		// The log is opened without the up lock: it only appends one line.
		if opened, err := logx.Open(paths.LogFile()); err == nil {
			defer opened.Close()
			log = opened
		}
	}
	log.Event("up_stop_final", "reason", reason)
	return 0
}

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
	serviceMode := false
	for _, arg := range inv.args {
		if arg != "--service" || serviceMode {
			fmt.Fprintln(inv.stderr, upUsage)
			return 2
		}
		serviceMode = true
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		return 1
	}
	// None of these stops makes a network call, so a restarted client never
	// reaches the server.
	creds, err := paths.LoadCredentials()
	if errors.Is(err, config.ErrNotLoggedIn) {
		return upStop(inv, serviceMode, &paths, nil, "not_logged_in",
			"aiqsa-connect: not logged in — run aiqsa-connect login <AIQSA address>")
	}
	if err != nil {
		return upStop(inv, serviceMode, &paths, nil, "credentials_invalid", fmt.Sprintf("aiqsa-connect up: %v", err))
	}
	if err := paths.EnsureStateDir(); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect up: cannot create the state directory: %v\n", err)
		return 1
	}
	release, err := daemon.AcquireLock(paths.LockFile())
	// A service restart can briefly overlap the stopping client.
	for deadline := time.Now().Add(serviceLockWait); serviceMode && errors.Is(err, daemon.ErrAlreadyRunning) &&
		time.Now().Before(deadline) && api.Sleep(inv.ctx, 500*time.Millisecond) == nil; {
		release, err = daemon.AcquireLock(paths.LockFile())
	}
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		return upStop(inv, serviceMode, &paths, nil, "already_running", fmt.Sprintf("aiqsa-connect up: %v", err))
	}
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
	binder, _ := updater.(upBinder)
	if binder != nil {
		binder.bindUp(ctx, cancel, creds.Origin, log, inv.stderr)
	}
	for _, hook := range upHooks {
		if err := hook(ctx, d); err != nil {
			fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
		}
	}
	err = d.Run(ctx)
	if err == nil && inv.ctx.Err() == nil && binder != nil {
		if code, restarted := binder.restartUpdated(inv.stderr); restarted {
			return code
		}
	}
	switch {
	case err == nil:
		return 0
	case errors.Is(err, daemon.ErrRevoked):
		retireRevokedCredentials(paths, creds)
		return upStop(inv, serviceMode, &paths, log, "revoked", "aiqsa-connect: device revoked — run aiqsa-connect login")
	case errors.Is(err, daemon.ErrReplaced):
		fmt.Fprintln(inv.stderr, "aiqsa-connect: another aiqsa-connect process is connected as this device")
		return 0
	}
	fmt.Fprintf(inv.stderr, "aiqsa-connect up: %v\n", err)
	return 1
}

// retireRevokedCredentials moves the revoked token aside, so a restarted `up`
// stops at once without asking the server again. Credentials written by a
// newer login stay.
func retireRevokedCredentials(paths config.Paths, revoked config.Credentials) {
	current, err := paths.LoadCredentials()
	if err != nil || current.DeviceToken != revoked.DeviceToken {
		return
	}
	os.Rename(paths.CredentialsFile(), filepath.Join(paths.ConfigDir, revokedCredentialsFile))
}
