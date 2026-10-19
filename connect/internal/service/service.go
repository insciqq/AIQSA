// Package service installs `aiqsa-connect up` as a per-user background
// service: a systemd user unit on Linux (and WSL with systemd), a launchd
// LaunchAgent on macOS. Restarting or updating the client must never stop
// the tmux server that holds the sessions, so systemd kills only the main
// process (KillMode=process) and launchd leaves the process group alone
// (AbandonProcessGroup).
package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// SystemdUnitName is the user unit's name.
	SystemdUnitName = "aiqsa-connect.service"
	// LaunchdLabel is the LaunchAgent's label and file name.
	LaunchdLabel = "io.github.insciqq.aiqsa-connect"
	// RevokedExitStatus is the status of `up` for revoked or missing
	// credentials; the service must not restart it.
	RevokedExitStatus = 3
	// RestartDelaySeconds is the pause before a failed client is restarted.
	RestartDelaySeconds = 5
)

// ErrNoUserSystemd means this Linux computer has no systemd user manager,
// as on WSL without systemd.
var ErrNoUserSystemd = errors.New("systemd user services are not available on this computer")

// Spec describes the service to install.
type Spec struct {
	// Executable is the absolute path of aiqsa-connect.
	Executable string
	// Path is the PATH the service runs with: the installing shell's, so
	// sessions find the same tools (nvm, Homebrew) as the user's terminal.
	Path string
}

func (s Spec) validate() error {
	if !filepath.IsAbs(s.Executable) {
		return errors.New("the aiqsa-connect path must be absolute")
	}
	for _, value := range []string{s.Executable, s.Path} {
		if strings.ContainsFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return errors.New("the service paths must not contain control characters")
		}
	}
	return nil
}

// systemdQuote quotes a word for ExecStart= and Environment=: backslashes and
// quotes are escaped, % specifiers and (for ExecStart) $ expansion disabled.
func systemdQuote(value string, execLine bool) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, "%", "%%")
	if execLine {
		value = strings.ReplaceAll(value, "$", "$$")
	}
	return `"` + value + `"`
}

// SystemdUnit is the user unit for spec.
func SystemdUnit(spec Spec) (string, error) {
	if err := spec.validate(); err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("# Installed by aiqsa-connect service install; remove with aiqsa-connect service uninstall.\n")
	b.WriteString("[Unit]\n")
	b.WriteString("Description=AIQSA Connect client\n")
	b.WriteString("Documentation=https://github.com/insciqq/AIQSA/blob/main/connect/README.md\n\n")
	b.WriteString("[Service]\n")
	b.WriteString("Type=simple\n")
	fmt.Fprintf(&b, "ExecStart=%s up\n", systemdQuote(spec.Executable, true))
	b.WriteString("Restart=on-failure\n")
	fmt.Fprintf(&b, "RestartSec=%d\n", RestartDelaySeconds)
	b.WriteString("# A revoked or logged-out client exits 3 and stays stopped.\n")
	fmt.Fprintf(&b, "RestartPreventExitStatus=%d\n", RevokedExitStatus)
	b.WriteString("# Stop or restart only the client: the tmux server with the sessions keeps running.\n")
	b.WriteString("KillMode=process\n")
	fmt.Fprintf(&b, "Environment=%s\n\n", systemdQuote("PATH="+spec.Path, false))
	b.WriteString("[Install]\n")
	b.WriteString("WantedBy=default.target\n")
	return b.String(), nil
}

func xmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(value)
}

// LaunchAgentPlist is the LaunchAgent for spec.
func LaunchAgentPlist(spec Spec) (string, error) {
	if err := spec.validate(); err != nil {
		return "", err
	}
	str := func(value string) string { return "<string>" + xmlEscape(value) + "</string>" }
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Installed by aiqsa-connect service install; remove with aiqsa-connect service uninstall. -->
<plist version="1.0">
<dict>
`)
	fmt.Fprintf(&b, "\t<key>Label</key>\n\t%s\n", str(LaunchdLabel))
	fmt.Fprintf(&b, "\t<key>ProgramArguments</key>\n\t<array>\n\t\t%s\n\t\t%s\n\t</array>\n", str(spec.Executable), str("up"))
	b.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	// Restarted after a failure, not after a clean stop; launchd cannot
	// exclude status 3, so `up` without valid credentials exits at once
	// without contacting the server.
	b.WriteString("\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n")
	fmt.Fprintf(&b, "\t<key>ThrottleInterval</key>\n\t<integer>%d</integer>\n", 10)
	// The tmux server started by the client keeps running when launchd stops it.
	b.WriteString("\t<key>AbandonProcessGroup</key>\n\t<true/>\n")
	// Sessions are interactive work, not background jobs to be throttled.
	b.WriteString("\t<key>ProcessType</key>\n\t<string>Interactive</string>\n")
	fmt.Fprintf(&b, "\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t%s\n\t</dict>\n", str(spec.Path))
	// The client keeps its own size-bounded log in ~/.local/state/aiqsa-connect;
	// a launchd output file would grow without bound.
	fmt.Fprintf(&b, "\t<key>StandardOutPath</key>\n\t%s\n", str(os.DevNull))
	fmt.Fprintf(&b, "\t<key>StandardErrorPath</key>\n\t%s\n", str(os.DevNull))
	b.WriteString("</dict>\n</plist>\n")
	return b.String(), nil
}

// Runner runs a service-manager command and returns its combined output.
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// Manager installs, removes and inspects the service. Its fields are the
// platform facts; tests fill them instead of touching the real system.
type Manager struct {
	// GOOS is "linux" or "darwin".
	GOOS string
	// Home is the user's home directory; ConfigHome is $XDG_CONFIG_HOME or ~/.config.
	Home, ConfigHome string
	UID              int
	User             string
	Run              Runner
	// Timeout bounds every command; zero is 30 seconds.
	Timeout time.Duration
}

// Status is the service's state.
type Status struct {
	Installed bool
	Running   bool
	// Detail is the service manager's own summary, such as systemd's
	// ActiveState/SubState or launchd's last exit status.
	Detail string
	// LastExitRevoked is true when the client last stopped as not logged in or revoked.
	LastExitRevoked bool
}

// File is the service definition's path.
func (m Manager) File() string {
	if m.GOOS == "darwin" {
		return filepath.Join(m.Home, "Library", "LaunchAgents", LaunchdLabel+".plist")
	}
	return filepath.Join(m.ConfigHome, "systemd", "user", SystemdUnitName)
}

func (m Manager) run(ctx context.Context, name string, args ...string) (string, error) {
	timeout := m.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := m.Run(ctx, name, args...)
	if err != nil {
		if trimmed := strings.TrimSpace(out); trimmed != "" {
			return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, firstLine(trimmed))
		}
		return out, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return out, nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// CheckSystemd reports ErrNoUserSystemd when no systemd user manager answers.
func (m Manager) CheckSystemd(ctx context.Context) error {
	if _, err := m.run(ctx, "systemctl", "--user", "show-environment"); err != nil {
		return fmt.Errorf("%w (%v)", ErrNoUserSystemd, err)
	}
	return nil
}

func (m Manager) launchdTarget() string { return "gui/" + strconv.Itoa(m.UID) }

func (m Manager) launchdService() string { return m.launchdTarget() + "/" + LaunchdLabel }

// Install writes the service definition and (re)starts the service.
func (m Manager) Install(ctx context.Context, spec Spec) error {
	switch m.GOOS {
	case "linux":
		if err := m.CheckSystemd(ctx); err != nil {
			return err
		}
		unit, err := SystemdUnit(spec)
		if err != nil {
			return err
		}
		if err := writeFile(m.File(), unit); err != nil {
			return err
		}
		for _, args := range [][]string{
			{"--user", "daemon-reload"},
			{"--user", "enable", SystemdUnitName},
			// restart also starts a stopped unit and picks up a new binary or unit.
			{"--user", "restart", SystemdUnitName},
		} {
			if _, err := m.run(ctx, "systemctl", args...); err != nil {
				return err
			}
		}
		return nil
	case "darwin":
		plist, err := LaunchAgentPlist(spec)
		if err != nil {
			return err
		}
		if err := writeFile(m.File(), plist); err != nil {
			return err
		}
		// A loaded older definition is replaced; not being loaded is fine.
		m.run(ctx, "launchctl", "bootout", m.launchdService())
		if _, err := m.run(ctx, "launchctl", "enable", m.launchdService()); err != nil {
			return err
		}
		// launchd may still be tearing down the old job for a moment.
		for attempt := 1; ; attempt++ {
			_, err = m.run(ctx, "launchctl", "bootstrap", m.launchdTarget(), m.File())
			if err == nil || attempt == 3 || ctx.Err() != nil {
				return err
			}
			time.Sleep(time.Second)
		}
	}
	return fmt.Errorf("background services are supported on Linux and macOS, not on %s", m.GOOS)
}

// Uninstall stops the client and removes the service definition; the tmux
// sessions keep running. removed is false when no service was installed.
func (m Manager) Uninstall(ctx context.Context) (removed bool, err error) {
	if _, err := os.Stat(m.File()); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	switch m.GOOS {
	case "linux":
		if err := m.CheckSystemd(ctx); err != nil {
			return false, err
		}
		if _, err := m.run(ctx, "systemctl", "--user", "disable", "--now", SystemdUnitName); err != nil {
			return false, err
		}
		if err := os.Remove(m.File()); err != nil {
			return false, err
		}
		_, err := m.run(ctx, "systemctl", "--user", "daemon-reload")
		return true, err
	case "darwin":
		m.run(ctx, "launchctl", "bootout", m.launchdService())
		return true, os.Remove(m.File())
	}
	return false, fmt.Errorf("background services are supported on Linux and macOS, not on %s", m.GOOS)
}

// Status reports whether the service is installed and running.
func (m Manager) Status(ctx context.Context) (Status, error) {
	if _, err := os.Stat(m.File()); errors.Is(err, os.ErrNotExist) {
		return Status{}, nil
	}
	switch m.GOOS {
	case "linux":
		if err := m.CheckSystemd(ctx); err != nil {
			return Status{Installed: true}, err
		}
		out, err := m.run(ctx, "systemctl", "--user", "show", SystemdUnitName,
			"--property=ActiveState,SubState,ExecMainStatus")
		if err != nil {
			return Status{Installed: true}, err
		}
		props := parseProperties(out, "=")
		return Status{
			Installed:       true,
			Running:         props["ActiveState"] == "active",
			Detail:          strings.TrimSpace(props["ActiveState"] + " (" + props["SubState"] + ")"),
			LastExitRevoked: props["ExecMainStatus"] == strconv.Itoa(RevokedExitStatus),
		}, nil
	case "darwin":
		out, err := m.run(ctx, "launchctl", "print", m.launchdService())
		if err != nil {
			return Status{Installed: true, Detail: "not loaded"}, nil
		}
		props := parseProperties(out, " = ")
		status := Status{Installed: true, Running: props["state"] == "running", Detail: props["state"]}
		if code := props["last exit code"]; code != "" {
			status.Detail += ", last exit code " + code
			status.LastExitRevoked = code == strconv.Itoa(RevokedExitStatus)
		}
		return status, nil
	}
	return Status{}, fmt.Errorf("background services are supported on Linux and macOS, not on %s", m.GOOS)
}

// LingerHint suggests enabling lingering when the user's services stop at
// logout; empty when lingering is on or cannot be determined.
func (m Manager) LingerHint(ctx context.Context) string {
	if m.GOOS != "linux" || m.User == "" {
		return ""
	}
	out, err := m.run(ctx, "loginctl", "show-user", m.User, "--property=Linger")
	if err != nil || strings.TrimSpace(out) != "Linger=no" {
		return ""
	}
	return "Optional: to keep it running after you log out and start it at boot, run: loginctl enable-linger " + m.User
}

func parseProperties(out, separator string) map[string]string {
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), separator)
		if ok {
			if _, seen := props[key]; !seen {
				props[key] = strings.TrimSpace(value)
			}
		}
	}
	return props
}

func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}
