package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/service"
)

func withServiceManager(t *testing.T, goos string, run service.Runner) service.Manager {
	t.Helper()
	isolate(t)
	previousSettle := serviceSettle
	serviceSettle = 0
	t.Cleanup(func() { serviceSettle = previousSettle })
	home := t.TempDir()
	m := service.Manager{GOOS: goos, Home: home, ConfigHome: filepath.Join(home, ".config"), UID: 501, User: "ann", Run: run}
	previous := newServiceManager
	newServiceManager = func() (service.Manager, error) { return m, nil }
	t.Cleanup(func() { newServiceManager = previous })
	return m
}

const showUnit = "systemctl --user show aiqsa-connect.service --property=ActiveState,SubState"

// fakeSystemd answers every command, show with the unit's current state.
func fakeSystemd(state *string, calls *[]string) service.Runner {
	return func(_ context.Context, name string, args ...string) (string, error) {
		call := strings.Join(append([]string{name}, args...), " ")
		*calls = append(*calls, call)
		if call == showUnit {
			return *state, nil
		}
		return "", nil
	}
}

func TestServiceInstallWritesTheUnitForThisBinary(t *testing.T) {
	t.Setenv("PATH", "/home/ann/.nvm/bin:/usr/bin:/bin")
	var calls []string
	state := "ActiveState=active\nSubState=running\n"
	m := withServiceManager(t, "linux", fakeSystemd(&state, &calls))
	paths, _ := config.ResolvePaths()
	writeCredentials(t, paths, "https://ai.example.com")
	code, stdout, stderr := runArgs("service", "install")
	if code != 0 || !strings.Contains(stdout, "Installed and started the aiqsa-connect service ("+m.File()+"): active (running).") {
		t.Fatalf("install: %d %q %q", code, stdout, stderr)
	}
	data, err := os.ReadFile(m.File())
	if err != nil {
		t.Fatal(err)
	}
	unit := string(data)
	if !strings.Contains(unit, `ExecStart="`+selfExecutable()+`" up --service`+"\n") || !strings.Contains(unit, `Environment="PATH=/home/ann/.nvm/bin:/usr/bin:/bin"`) {
		t.Fatalf("unit:\n%s", unit)
	}
	// The state is read after the restart.
	if joined := strings.Join(calls, "\n"); strings.LastIndex(joined, showUnit) < strings.Index(joined, "systemctl --user restart aiqsa-connect.service") {
		t.Fatalf("calls: %v", calls)
	}

	// A client that stopped after the restart is reported with its state.
	state = "ActiveState=activating\nSubState=auto-restart\n"
	code, stdout, stderr = runArgs("service", "install")
	if code != 1 || !strings.Contains(stdout, "but it is not running: activating (auto-restart).") ||
		!strings.Contains(stderr, paths.LogFile()) || !strings.Contains(stderr, "journalctl --user -u aiqsa-connect") {
		t.Fatalf("stopped: %d %q %q", code, stdout, stderr)
	}
}

func TestServiceInstallAndStatusNameWhyTheClientStops(t *testing.T) {
	var calls []string
	state := "ActiveState=inactive\nSubState=dead\n"
	withServiceManager(t, "linux", fakeSystemd(&state, &calls))
	paths, _ := config.ResolvePaths()

	code, stdout, stderr := runArgs("service", "install")
	if code != 1 || !strings.Contains(stdout, "but it stops at once") || !strings.Contains(stderr, "This computer is not logged in: run aiqsa-connect login") {
		t.Fatalf("not logged in: %d %q %q", code, stdout, stderr)
	}
	if !strings.Contains(strings.Join(calls, "\n"), "systemctl --user restart aiqsa-connect.service") {
		t.Fatalf("not installed: %v", calls)
	}
	if code, stdout, _ := runArgs("service", "status"); code != 1 || !strings.Contains(stdout, "installed and stopped: inactive (dead)") ||
		!strings.Contains(stdout, "not logged in") {
		t.Fatalf("status: %d %q", code, stdout)
	}

	if err := paths.EnsureConfigDir(); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(paths.ConfigDir, revokedCredentialsFile), []byte("{}"), 0o600)
	if code, stdout, _ := runArgs("service", "status"); code != 1 || !strings.Contains(stdout, "was revoked in AIQSA") {
		t.Fatalf("revoked status: %d %q", code, stdout)
	}

	writeCredentials(t, paths, "https://ai.example.com")
	os.Chmod(paths.CredentialsFile(), 0o644)
	if code, _, stderr := runArgs("service", "install"); code != 1 || !strings.Contains(stderr, "Its credentials cannot be used") || !strings.Contains(stderr, "chmod 600") {
		t.Fatalf("readable credentials: %d %q", code, stderr)
	}

	// A foreground up holds the lock while the service is stopped.
	writeCredentials(t, paths, "https://ai.example.com")
	paths.EnsureStateDir()
	release, err := daemon.AcquireLock(paths.LockFile())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if code, _, stderr := runArgs("service", "install"); code != 1 || !strings.Contains(stderr, "Another aiqsa-connect up is running") {
		t.Fatalf("foreground up: %d %q", code, stderr)
	}
	// While the service runs, it holds the lock itself: no false alarm.
	state = "ActiveState=active\nSubState=running\n"
	if code, stdout, stderr := runArgs("service", "install"); code != 0 || !strings.Contains(stdout, "Installed and started") {
		t.Fatalf("running service: %d %q %q", code, stdout, stderr)
	}
}

func TestServiceWithoutUserSystemdSuggestsUp(t *testing.T) {
	withServiceManager(t, "linux", func(context.Context, string, ...string) (string, error) {
		return "System has not been booted with systemd as init system (PID 1). Can't operate.", errors.New("exit status 1")
	})
	for _, action := range []string{"install", "status"} {
		code, _, stderr := runArgs("service", action)
		if action == "status" {
			// Status of a service that was never installed needs no systemd.
			if code != 1 {
				t.Fatalf("status: %d %q", code, stderr)
			}
			continue
		}
		if code != 1 || !strings.Contains(stderr, "systemd user services are not available") ||
			!strings.Contains(stderr, "/etc/wsl.conf") || !strings.Contains(stderr, "aiqsa-connect up") {
			t.Fatalf("%s: %d %q", action, code, stderr)
		}
	}
}

func TestServiceUsage(t *testing.T) {
	withServiceManager(t, "linux", func(context.Context, string, ...string) (string, error) { return "", nil })
	for _, args := range [][]string{{"service"}, {"service", "restart"}, {"service", "install", "now"}} {
		if code, _, stderr := runArgs(args...); code != 2 || !strings.Contains(stderr, "service install|uninstall|status") {
			t.Fatalf("%v: %d %q", args, code, stderr)
		}
	}
	if code, stdout, _ := runArgs("service", "uninstall"); code != 0 || !strings.Contains(stdout, "not installed") {
		t.Fatalf("uninstall: %d %q", code, stdout)
	}
}
