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
	if err := manager.Install(inv.ctx, service.Spec{Executable: executable, Path: path}); err != nil {
		if noUserSystemd(inv, err) {
			return 1
		}
		fmt.Fprintf(inv.stderr, "aiqsa-connect service install: %v\n", err)
		return 1
	}
	fmt.Fprintf(inv.stdout, "Installed and started the aiqsa-connect service (%s).\n", manager.File())
	fmt.Fprintln(inv.stdout, "It runs aiqsa-connect up whenever you are logged in to this computer; your sessions survive its restarts and updates.")
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
	if !status.Running && status.LastExitRevoked {
		fmt.Fprintln(inv.stdout, "It stopped because this computer is not logged in or was revoked: run aiqsa-connect login <AIQSA address>, then aiqsa-connect service install.")
	}
	if status.Running {
		return 0
	}
	return 1
}
