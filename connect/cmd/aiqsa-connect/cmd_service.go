package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/service"
)

func init() {
	register(command{
		name:    "service",
		usage:   "service install|uninstall|status",
		summary: "Run the client in the background as a user service",
		run:     runService,
	})
}

// newServiceManager describes this computer's service manager; tests replace it.
var newServiceManager = func() (service.Manager, error) {
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return service.Manager{}, errors.New("cannot determine the home directory")
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(configHome) {
		configHome = filepath.Join(home, ".config")
	}
	name := ""
	if current, err := user.Current(); err == nil {
		name = current.Username
	}
	return service.Manager{
		GOOS:       runtime.GOOS,
		Home:       home,
		ConfigHome: configHome,
		UID:        os.Getuid(),
		User:       name,
		Run: func(ctx context.Context, name string, args ...string) (string, error) {
			out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
			return string(out), err
		},
	}, nil
}

const serviceUsage = "Usage: aiqsa-connect service install|uninstall|status"

func runService(inv *invocation) int {
	if len(inv.args) != 1 {
		fmt.Fprintln(inv.stderr, serviceUsage)
		return 2
	}
	manager, err := newServiceManager()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect service: %v\n", err)
		return 1
	}
	switch inv.args[0] {
	case "install":
		return serviceInstall(inv, manager)
	case "uninstall":
		return serviceUninstall(inv, manager)
	case "status":
		return serviceStatus(inv, manager)
	}
	fmt.Fprintln(inv.stderr, serviceUsage)
	return 2
}

func noUserSystemd(inv *invocation, err error) bool {
	if !errors.Is(err, service.ErrNoUserSystemd) {
		return false
	}
	fmt.Fprintln(inv.stderr, "aiqsa-connect service: systemd user services are not available on this computer.")
	fmt.Fprintln(inv.stderr, "On WSL, turn systemd on: add \"[boot]\" and \"systemd=true\" to /etc/wsl.conf, then run wsl --shutdown in Windows.")
	fmt.Fprintln(inv.stderr, "Without a service, keep aiqsa-connect up running in a terminal (for example in your own tmux or screen).")
	return true
}

func serviceInstall(inv *invocation, manager service.Manager) int {
	executable := selfExecutable()
	if executable == "" {
		fmt.Fprintln(inv.stderr, "aiqsa-connect service: cannot find this program's own file")
		return 1
	}
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	// Known before the restart: the service would stop at once. A running
	// service holds the lock itself, so the lock is checked only otherwise.
	reason := credentialsStopReason()
	if before, err := manager.Status(inv.ctx); reason == "" && err == nil && !before.Running {
		reason = lockStopReason()
	}
	if err := manager.Install(inv.ctx, service.Spec{Executable: executable, Path: path}); err != nil {
		if noUserSystemd(inv, err) {
			return 1
		}
		fmt.Fprintf(inv.stderr, "aiqsa-connect service install: %v\n", err)
		return 1
	}
	if reason != "" {
		fmt.Fprintf(inv.stdout, "Installed the aiqsa-connect service (%s), but it stops at once.\n", manager.File())
		fmt.Fprintln(inv.stderr, reason)
		return 1
	}
	if api.Sleep(inv.ctx, serviceSettle) != nil {
		return 1
	}
	status, err := manager.Status(inv.ctx)
	if err != nil {
		fmt.Fprintf(inv.stdout, "Installed the aiqsa-connect service (%s).\n", manager.File())
		fmt.Fprintf(inv.stderr, "aiqsa-connect service install: cannot check whether it runs: %v\n", err)
		return 1
	}
	if !status.Running {
		fmt.Fprintf(inv.stdout, "Installed the aiqsa-connect service (%s), but it is not running: %s.\n", manager.File(), status.Detail)
		fmt.Fprintln(inv.stderr, stopReason(manager))
		return 1
	}
	fmt.Fprintf(inv.stdout, "Installed and started the aiqsa-connect service (%s): %s.\n", manager.File(), status.Detail)
	fmt.Fprintln(inv.stdout, "It runs aiqsa-connect up --service whenever you are logged in to this computer; your sessions survive its restarts and updates.")
	if version == "dev" {
		fmt.Fprintf(inv.stdout, "Note: this is a development build at %s; the service keeps using that file.\n", executable)
	}
	if hint := manager.LingerHint(inv.ctx); hint != "" {
		fmt.Fprintln(inv.stdout, hint)
	}
	return 0
}

func serviceUninstall(inv *invocation, manager service.Manager) int {
	removed, err := manager.Uninstall(inv.ctx)
	if err != nil {
		if noUserSystemd(inv, err) {
			return 1
		}
		fmt.Fprintf(inv.stderr, "aiqsa-connect service uninstall: %v\n", err)
		return 1
	}
	if !removed {
		fmt.Fprintln(inv.stdout, "The aiqsa-connect service is not installed.")
		return 0
	}
	fmt.Fprintln(inv.stdout, "Stopped and removed the aiqsa-connect service. Your tmux sessions keep running; aiqsa-connect sessions lists them.")
	return 0
}

func serviceStatus(inv *invocation, manager service.Manager) int {
	status, err := manager.Status(inv.ctx)
	if err != nil {
		if noUserSystemd(inv, err) {
			return 1
		}
		fmt.Fprintf(inv.stderr, "aiqsa-connect service status: %v\n", err)
		return 1
	}
	if !status.Installed {
		fmt.Fprintln(inv.stdout, "The aiqsa-connect service is not installed. Install it with: aiqsa-connect service install")
		return 1
	}
	state := "stopped"
	if status.Running {
		state = "running"
	}
	fmt.Fprintf(inv.stdout, "The aiqsa-connect service is installed and %s: %s (%s).\n", state, status.Detail, manager.File())
	if status.Running {
		return 0
	}
	fmt.Fprintln(inv.stdout, stopReason(manager))
	return 1
}

// serviceSettle is how long `service install` lets the restarted client run
// before it reports the service's state; tests shorten it.
var serviceSettle = 2 * time.Second

// credentialsStopReason names why `up --service` would stop at once for its
// credentials, or is empty.
func credentialsStopReason() string {
	paths, err := config.ResolvePaths()
	if err != nil {
		return ""
	}
	_, err = paths.LoadCredentials()
	switch {
	case err == nil:
		return ""
	case errors.Is(err, config.ErrNotLoggedIn):
		if _, statErr := os.Stat(filepath.Join(paths.ConfigDir, revokedCredentialsFile)); statErr == nil {
			return "This computer was revoked in AIQSA: run aiqsa-connect login <AIQSA address>, then aiqsa-connect service install."
		}
		return "This computer is not logged in: run aiqsa-connect login <AIQSA address>, then aiqsa-connect service install."
	}
	return fmt.Sprintf("Its credentials cannot be used: %v. Then run aiqsa-connect service install.", err)
}

// lockStopReason names another running `up` that the service would give
// way to, or is empty. It takes the lock for a moment, so it is called only
// while the service itself is not running.
func lockStopReason() string {
	paths, err := config.ResolvePaths()
	if err != nil {
		return ""
	}
	release, err := daemon.AcquireLock(paths.LockFile())
	if err == nil {
		release()
	}
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		return "Another aiqsa-connect up is running on this computer (for example in a terminal): stop it, then run aiqsa-connect service install."
	}
	return ""
}

// stopReason explains a stopped service: its credentials, another `up`, or
// where its log is.
func stopReason(manager service.Manager) string {
	if reason := credentialsStopReason(); reason != "" {
		return reason
	}
	if reason := lockStopReason(); reason != "" {
		return reason
	}
	logFile := "~/.local/state/aiqsa-connect/aiqsa-connect.log"
	if paths, err := config.ResolvePaths(); err == nil {
		logFile = paths.LogFile()
	}
	if manager.GOOS == "linux" {
		return fmt.Sprintf("See its log, %s, and journalctl --user -u aiqsa-connect.", logFile)
	}
	return fmt.Sprintf("See its log, %s.", logFile)
}
