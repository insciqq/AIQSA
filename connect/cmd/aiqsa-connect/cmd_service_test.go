package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/service"
)

func withServiceManager(t *testing.T, goos string, run service.Runner) service.Manager {
	t.Helper()
	home := t.TempDir()
	m := service.Manager{GOOS: goos, Home: home, ConfigHome: filepath.Join(home, ".config"), UID: 501, User: "ann", Run: run}
	previous := newServiceManager
	newServiceManager = func() (service.Manager, error) { return m, nil }
	t.Cleanup(func() { newServiceManager = previous })
	return m
}

func TestServiceInstallWritesTheUnitForThisBinary(t *testing.T) {
	t.Setenv("PATH", "/home/ann/.nvm/bin:/usr/bin:/bin")
	var calls []string
	m := withServiceManager(t, "linux", func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, strings.Join(append([]string{name}, args...), " "))
		return "", nil
	})
	code, stdout, stderr := runArgs("service", "install")
	if code != 0 || !strings.Contains(stdout, "Installed and started the aiqsa-connect service") {
		t.Fatalf("install: %d %q %q", code, stdout, stderr)
	}
	data, err := os.ReadFile(m.File())
	if err != nil {
		t.Fatal(err)
	}
	unit := string(data)
	if !strings.Contains(unit, `ExecStart="`+selfExecutable()+`" up`) || !strings.Contains(unit, `Environment="PATH=/home/ann/.nvm/bin:/usr/bin:/bin"`) {
		t.Fatalf("unit:\n%s", unit)
	}
	if !strings.Contains(strings.Join(calls, "\n"), "systemctl --user restart aiqsa-connect.service") {
		t.Fatalf("calls: %v", calls)
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
