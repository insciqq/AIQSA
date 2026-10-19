package service

import (
	"context"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const exe = "/home/ann/.local/bin/aiqsa-connect"

func TestSystemdUnitRunsServiceModeAndKeepsSessions(t *testing.T) {
	unit, err := SystemdUnit(Spec{Executable: exe, Path: "/home/ann/.nvm/bin:/usr/bin"})
	if err != nil {
		t.Fatal(err)
	}
	want := `# Installed by aiqsa-connect service install; remove with aiqsa-connect service uninstall.
[Unit]
Description=AIQSA Connect client
Documentation=https://github.com/insciqq/AIQSA/blob/main/connect/README.md

[Service]
Type=simple
ExecStart="/home/ann/.local/bin/aiqsa-connect" up --service
Restart=on-failure
RestartSec=5
# A client that a restart cannot fix (logged out, revoked) exits 0 and stays stopped.
RestartPreventExitStatus=3
# Stop or restart only the client: the tmux server with the sessions keeps running.
KillMode=process
Environment="PATH=/home/ann/.nvm/bin:/usr/bin"

[Install]
WantedBy=default.target
`
	if unit != want {
		t.Fatalf("unit:\n%s", unit)
	}
}

func TestSystemdUnitQuotesSpecialCharacters(t *testing.T) {
	unit, err := SystemdUnit(Spec{Executable: `/home/a b/100%/$x/"q"\bin`, Path: `/p%h:/q"r`})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		`ExecStart="/home/a b/100%%/$$x/\"q\"\\bin" up --service`,
		`Environment="PATH=/p%%h:/q\"r"`,
	} {
		if !strings.Contains(unit, line+"\n") {
			t.Errorf("unit lacks %s:\n%s", line, unit)
		}
	}
	for _, spec := range []Spec{{Executable: "aiqsa-connect"}, {Executable: exe, Path: "/bin\n[Service]"}} {
		if _, err := SystemdUnit(spec); err == nil {
			t.Errorf("accepted %+v", spec)
		}
	}
}

type plistValue struct {
	XMLName xml.Name
	Content string       `xml:",chardata"`
	Items   []plistValue `xml:",any"`
}

func TestLaunchAgentPlist(t *testing.T) {
	plist, err := LaunchAgentPlist(Spec{Executable: "/Users/ann/bin/a&b/aiqsa-connect", Path: "/opt/homebrew/bin:/usr/bin"})
	if err != nil {
		t.Fatal(err)
	}
	var doc plistValue
	if err := xml.Unmarshal([]byte(plist), &doc); err != nil {
		t.Fatalf("invalid XML: %v\n%s", err, plist)
	}
	dict := doc.Items[0].Items
	values := map[string]plistValue{}
	for i := 0; i+1 < len(dict); i += 2 {
		values[dict[i].Content] = dict[i+1]
	}
	str := func(key string) string { return values[key].Content }
	if str("Label") != LaunchdLabel {
		t.Errorf("Label = %q", str("Label"))
	}
	args := values["ProgramArguments"].Items
	if len(args) != 3 || args[0].Content != "/Users/ann/bin/a&b/aiqsa-connect" || args[1].Content != "up" || args[2].Content != "--service" {
		t.Errorf("ProgramArguments = %+v", args)
	}
	for _, key := range []string{"RunAtLoad", "AbandonProcessGroup"} {
		if values[key].XMLName.Local != "true" {
			t.Errorf("%s = %s", key, values[key].XMLName.Local)
		}
	}
	keepAlive := values["KeepAlive"].Items
	if len(keepAlive) != 2 || keepAlive[0].Content != "SuccessfulExit" || keepAlive[1].XMLName.Local != "false" {
		t.Errorf("KeepAlive = %+v", keepAlive)
	}
	env := values["EnvironmentVariables"].Items
	if len(env) != 2 || env[0].Content != "PATH" || env[1].Content != "/opt/homebrew/bin:/usr/bin" {
		t.Errorf("EnvironmentVariables = %+v", env)
	}
	if str("StandardOutPath") != os.DevNull || str("StandardErrorPath") != os.DevNull {
		t.Errorf("output paths = %q %q", str("StandardOutPath"), str("StandardErrorPath"))
	}
}

type fakeSystem struct {
	calls    []string
	outputs  map[string]string
	failures map[string]error
}

func (f *fakeSystem) run(_ context.Context, name string, args ...string) (string, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, call)
	return f.outputs[call], f.failures[call]
}

func manager(t *testing.T, goos string, system *fakeSystem) Manager {
	home := t.TempDir()
	return Manager{GOOS: goos, Home: home, ConfigHome: filepath.Join(home, ".config"), UID: 501, User: "ann", Run: system.run}
}

func TestSystemdInstallUninstallAndStatus(t *testing.T) {
	system := &fakeSystem{outputs: map[string]string{
		"systemctl --user show aiqsa-connect.service --property=ActiveState,SubState": "ActiveState=active\nSubState=running\n",
		"loginctl show-user ann --property=Linger":                                    "Linger=no\n",
	}}
	m := manager(t, "linux", system)
	if status, err := m.Status(context.Background()); err != nil || status.Installed {
		t.Fatalf("status before install: %+v %v", status, err)
	}
	if err := m.Install(context.Background(), Spec{Executable: exe, Path: "/usr/bin"}); err != nil {
		t.Fatal(err)
	}
	if m.File() != filepath.Join(m.ConfigHome, "systemd", "user", "aiqsa-connect.service") {
		t.Fatalf("unit path %s", m.File())
	}
	data, err := os.ReadFile(m.File())
	if err != nil || !strings.Contains(string(data), "KillMode=process") {
		t.Fatalf("unit file: %q %v", data, err)
	}
	want := []string{
		"systemctl --user show-environment",
		"systemctl --user daemon-reload",
		"systemctl --user enable aiqsa-connect.service",
		"systemctl --user restart aiqsa-connect.service",
	}
	if strings.Join(system.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(system.calls, "\n"))
	}
	if hint := m.LingerHint(context.Background()); !strings.Contains(hint, "loginctl enable-linger ann") {
		t.Fatalf("linger hint %q", hint)
	}
	status, err := m.Status(context.Background())
	if err != nil || !status.Installed || !status.Running || status.Detail != "active (running)" {
		t.Fatalf("status: %+v %v", status, err)
	}

	system.calls = nil
	removed, err := m.Uninstall(context.Background())
	if err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	want = []string{
		"systemctl --user show-environment",
		"systemctl --user disable --now aiqsa-connect.service",
		"systemctl --user daemon-reload",
	}
	if strings.Join(system.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(system.calls, "\n"))
	}
	if _, err := os.Stat(m.File()); !os.IsNotExist(err) {
		t.Fatalf("unit kept: %v", err)
	}
	if removed, err := m.Uninstall(context.Background()); err != nil || removed {
		t.Fatalf("second uninstall: %v %v", removed, err)
	}
}

func TestMissingUserSystemdIsReportedBeforeAnyChange(t *testing.T) {
	system := &fakeSystem{failures: map[string]error{
		"systemctl --user show-environment": errors.New("exit status 1"),
	}, outputs: map[string]string{
		"systemctl --user show-environment": "System has not been booted with systemd as init system (PID 1). Can't operate.\n",
	}}
	m := manager(t, "linux", system)
	err := m.Install(context.Background(), Spec{Executable: exe, Path: "/usr/bin"})
	if !errors.Is(err, ErrNoUserSystemd) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(m.File()); !os.IsNotExist(err) {
		t.Fatal("wrote a unit without systemd")
	}
	if len(system.calls) != 1 {
		t.Fatalf("calls: %v", system.calls)
	}
}

func TestLaunchdInstallUninstallAndStatus(t *testing.T) {
	system := &fakeSystem{
		failures: map[string]error{"launchctl bootout gui/501/" + LaunchdLabel: errors.New("not loaded")},
		outputs: map[string]string{
			"launchctl print gui/501/" + LaunchdLabel: "gui/501/io.github.insciqq.aiqsa-connect = {\n\tstate = not running\n\tlast exit code = 3\n}\n",
		},
	}
	m := manager(t, "darwin", system)
	if err := m.Install(context.Background(), Spec{Executable: exe, Path: "/usr/bin"}); err != nil {
		t.Fatal(err)
	}
	if m.File() != filepath.Join(m.Home, "Library", "LaunchAgents", LaunchdLabel+".plist") {
		t.Fatalf("plist path %s", m.File())
	}
	want := []string{
		"launchctl bootout gui/501/" + LaunchdLabel,
		"launchctl enable gui/501/" + LaunchdLabel,
		"launchctl bootstrap gui/501 " + m.File(),
	}
	if strings.Join(system.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(system.calls, "\n"))
	}
	status, err := m.Status(context.Background())
	if err != nil || !status.Installed || status.Running || status.Detail != "not running, last exit code 3" {
		t.Fatalf("status: %+v %v", status, err)
	}
	if hint := m.LingerHint(context.Background()); hint != "" {
		t.Fatalf("linger hint on macOS: %q", hint)
	}
	removed, err := m.Uninstall(context.Background())
	if err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	if _, err := os.Stat(m.File()); !os.IsNotExist(err) {
		t.Fatalf("plist kept: %v", err)
	}
}
