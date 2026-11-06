package winapp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/config"
)

func TestInstallPlacesTheProgramAndRegistersIt(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	self := f.download(t, "AIQSA Connect - ai.example.com (1).exe", "program v1")

	if code := f.installer.Launch(context.Background(), self); code != 0 {
		t.Fatalf("code = %d, shown %q", code, f.dialogs.shown)
	}
	if len(f.dialogs.asked) != 1 || !strings.HasPrefix(f.dialogs.asked[0], "Install AIQSA Connect for ai.example.com?\n\nIt lets the AIQSA agent work with files and run commands on this computer with your permissions.") {
		t.Fatalf("asked %q", f.dialogs.asked)
	}
	layout := f.installer.Layout
	exe := filepath.Join(f.home, "AppData", "Local", "Programs", "AIQSA Connect", "aiqsa-connect.exe")
	if layout.Exe() != exe || readString(t, exe) != "program v1" {
		t.Fatalf("program not placed at %s", exe)
	}
	if entries, _ := os.ReadDir(layout.ProgramDir); len(entries) != 1 {
		t.Fatalf("program folder holds %d files", len(entries))
	}
	if layout.LoadOrigin() != testOrigin {
		t.Fatalf("origin = %q", layout.LoadOrigin())
	}
	if info, err := os.Stat(layout.OriginFile()); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("origin file: %v %v", info, err)
	}
	want := map[string]any{
		`Software\Microsoft\Windows\CurrentVersion\Run\AIQSA Connect`:                      `"` + exe + `" up --tray`,
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\DisplayName`:     "AIQSA Connect",
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\DisplayVersion`:  "1.2.3",
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\Publisher`:       "AIQSA",
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\DisplayIcon`:     exe + ",0",
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\InstallLocation`: layout.ProgramDir,
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\UninstallString`: `"` + exe + `" uninstall`,
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\NoModify`:        uint32(1),
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\NoRepair`:        uint32(1),
		`Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect\EstimatedSize`:   uint32(1),
	}
	if got := f.registry.keys(); len(got) != len(want) {
		t.Fatalf("registry values: %v", got)
	}
	for name, value := range want {
		if f.registry.values[name] != value {
			t.Errorf("%s = %#v, want %#v", name, f.registry.values[name], value)
		}
	}
	if got := f.journal.list(); !slices.Equal(got, []string{"confirm Install AIQSA Connect", "start aiqsa-connect.exe up --tray"}) {
		t.Fatalf("journal: %v", got)
	}
	// The downloaded file stays where it is.
	if !exists(self) {
		t.Fatal("the downloaded file was removed")
	}
}

func TestInstallCancelledChangesNothing(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{false}
	self := f.download(t, "AIQSA Connect - ai.example.com.exe", "program")
	if code := f.installer.Launch(context.Background(), self); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if exists(f.installer.Layout.ProgramDir) || exists(f.installer.Layout.ConfigDir) || len(f.registry.values) != 0 {
		t.Fatal("cancelled install left something behind")
	}
}

func TestAnUnrecognizedFileNameAsksToDownloadAgain(t *testing.T) {
	f := newInstallFixture(t)
	self := f.download(t, "aiqsa-connect-windows-amd64.exe", "program")
	if code := f.installer.Launch(context.Background(), self); code != 1 {
		t.Fatalf("code = %d", code)
	}
	if len(f.dialogs.shown) != 1 || !strings.Contains(f.dialogs.shown[0], "Download AIQSA Connect again from your AIQSA page.") {
		t.Fatalf("shown %q", f.dialogs.shown)
	}
	if len(f.dialogs.asked) != 0 || exists(f.installer.Layout.ProgramDir) {
		t.Fatal("installed from an unrecognized file")
	}
}

func TestReinstallOfTheSameOriginUpdatesInPlaceAndOpensAIQSA(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	first := f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1")
	f.installer.Launch(context.Background(), first)
	f.saveCredentials(t, testOrigin)
	f.journal.entries = nil

	// The same file again: nothing to replace, the tray runs, AIQSA opens.
	if code := f.installer.Launch(context.Background(), first); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	if got := f.journal.list(); !slices.Equal(got, []string{"open https://ai.example.com"}) {
		t.Fatalf("same file: %v", got)
	}

	// A newer download of the same origin: no question, the running tray is
	// stopped, the file replaced in place and the tray started again.
	f.journal.entries = nil
	f.installer.Version = "1.3.0"
	second := f.download(t, "AIQSA Connect - ai.example.com (1).exe", "program v2")
	if code := f.installer.Launch(context.Background(), second); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	want := []string{"stop running=true", "start aiqsa-connect.exe up --tray", "open https://ai.example.com"}
	if got := f.journal.list(); !slices.Equal(got, want) {
		t.Fatalf("newer file: %v", got)
	}
	exe := f.installer.Layout.Exe()
	if readString(t, exe) != "program v2" || f.registry.values[UninstallKey+`\DisplayVersion`] != "1.3.0" {
		t.Fatal("not updated in place")
	}
	if creds, err := f.installer.Layout.Paths().LoadCredentials(); err != nil || creds.Origin != testOrigin {
		t.Fatalf("credentials lost: %v", err)
	}
	if len(f.revoked) != 0 {
		t.Fatal("revoked on a reinstall")
	}
}

func TestReinstallWithoutCredentialsLeavesPairingToTheTray(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	self := f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1")
	f.installer.Launch(context.Background(), self)
	f.system.running = false // quit from the tray
	f.journal.entries = nil
	if code := f.installer.Launch(context.Background(), self); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := f.journal.list(); !slices.Equal(got, []string{"start aiqsa-connect.exe up --tray"}) {
		t.Fatalf("journal: %v", got)
	}
	// While that tray waits for approval, another start opens AIQSA.
	f.journal.entries = nil
	f.installer.Launch(context.Background(), self)
	if got := f.journal.list(); !slices.Equal(got, []string{"open https://ai.example.com"}) {
		t.Fatalf("journal: %v", got)
	}
}

func TestAnotherOriginAsksToSwitchRevokesAndPairsAgain(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1"))
	f.saveCredentials(t, testOrigin)
	f.journal.entries = nil

	other := f.download(t, "AIQSA Connect - http_192.168.1.5_3000.exe", "program v1")
	f.dialogs.answers = []bool{false}
	if code := f.installer.Launch(context.Background(), other); code != 0 || len(f.journal.list()) != 1 {
		t.Fatalf("cancelled switch: %d %v", code, f.journal.list())
	}
	if f.installer.Layout.LoadOrigin() != testOrigin || len(f.revoked) != 0 {
		t.Fatal("a cancelled switch changed the installation")
	}

	f.journal.entries = nil
	f.dialogs.answers = []bool{true}
	if code := f.installer.Launch(context.Background(), other); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	if last := f.dialogs.asked[len(f.dialogs.asked)-1]; !strings.HasPrefix(last, "Switch AIQSA Connect to 192.168.1.5:3000?\n\nThis computer is disconnected from ai.example.com") {
		t.Fatalf("asked %q", last)
	}
	want := []string{"confirm Switch AIQSA Connect", "stop running=true", "revoke https://ai.example.com", "start aiqsa-connect.exe up --tray"}
	if got := f.journal.list(); !slices.Equal(got, want) {
		t.Fatalf("journal: %v", got)
	}
	if f.installer.Layout.LoadOrigin() != "http://192.168.1.5:3000" {
		t.Fatalf("origin = %q", f.installer.Layout.LoadOrigin())
	}
	if _, err := f.installer.Layout.Paths().LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("old credentials kept: %v", err)
	}
}

func TestSwitchGoesOnWhenTheOldServerCannotBeReached(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true, true}
	f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1"))
	f.saveCredentials(t, testOrigin)
	f.revokeErr = errors.New("unreachable")
	if code := f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.other.example.exe", "program v1")); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if f.installer.Layout.LoadOrigin() != "https://ai.other.example" {
		t.Fatal("not switched")
	}
	if last := f.dialogs.shown[len(f.dialogs.shown)-1]; !strings.Contains(last, "AIQSA at ai.example.com could not be reached") {
		t.Fatalf("shown %q", f.dialogs.shown)
	}
}

func TestTheInstalledProgramOpensAIQSAOrStartsTheTray(t *testing.T) {
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1"))
	exe := f.installer.Layout.Exe()
	f.journal.entries = nil

	// Running: a second start opens AIQSA instead of a second tray.
	if code := f.installer.Launch(context.Background(), strings.ToUpper(exe[:1])+exe[1:]); code != 0 {
		t.Fatalf("code = %d", code)
	}
	f.system.running = false
	if code := f.installer.Launch(context.Background(), exe); code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := []string{"open https://ai.example.com", "start aiqsa-connect.exe up --tray"}
	if got := f.journal.list(); !slices.Equal(got, want) {
		t.Fatalf("journal: %v", got)
	}
}

func installedFixture(t *testing.T) *installFixture {
	t.Helper()
	f := newInstallFixture(t)
	f.dialogs.answers = []bool{true}
	f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1"))
	f.saveCredentials(t, testOrigin)
	layout := f.installer.Layout
	if err := layout.Paths().EnsureStateDir(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(layout.StateDir, "aiqsa-connect.log"), filepath.Join(layout.ProgramDir, "aiqsa-connect.exe.old")} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f.journal.entries = nil
	f.dialogs.shown = nil
	return f
}

func TestUninstallRevokesFirstThenRemovesEverything(t *testing.T) {
	f := installedFixture(t)
	layout := f.installer.Layout
	f.dialogs.answers = []bool{true}
	// Windows Apps starts the installed program to uninstall.
	if code := f.installer.Uninstall(context.Background(), layout.Exe(), false); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	want := []string{
		"confirm Remove AIQSA Connect",
		"revoke https://ai.example.com",
		"stop running=true",
		`registry delete value AIQSA Connect`,
		`registry delete key ` + UninstallKey,
		"inform",
	}
	if got := f.journal.list(); !slices.Equal(got, want) {
		t.Fatalf("journal: %v", got)
	}
	if len(f.registry.values) != 0 {
		t.Fatalf("registry left: %v", f.registry.keys())
	}
	for _, dir := range []string{layout.ProgramDir, layout.ConfigDir, layout.StateDir} {
		if exists(dir) {
			t.Errorf("%s left", dir)
		}
	}
	// The running program file was moved to the temporary folder.
	moved, _ := filepath.Glob(filepath.Join(layout.TempDir, "aiqsa-connect-removed-*.exe"))
	if len(moved) != 1 || readString(t, moved[0]) != "program v1" {
		t.Fatalf("moved: %v", moved)
	}
	if !exists(filepath.Join(f.home, "AppData", "Local", "Programs")) {
		t.Fatal("removed more than the program folder")
	}
}

func TestUninstallToleratesEveryFailureAndSaysSo(t *testing.T) {
	f := installedFixture(t)
	f.revokeErr = errors.New("unreachable")
	f.system.stopErr = errors.New("still running")
	f.registry.fail["value"] = errors.New("access denied")
	if code := f.installer.Uninstall(context.Background(), filepath.Join(f.home, "Downloads", "x.exe"), true); code != 1 {
		t.Fatalf("code = %d", code)
	}
	if f.journal.index("confirm") != -1 {
		t.Fatal("asked although confirmed")
	}
	for _, step := range []string{"revoke", "stop", "registry delete value", "registry delete key", "warn"} {
		if f.journal.index(step) == -1 {
			t.Errorf("step %q skipped: %v", step, f.journal.list())
		}
	}
	shown := f.dialogs.shown[len(f.dialogs.shown)-1]
	for _, part := range []string{"could not be reached", "could not be stopped", "start at sign-in could not be removed"} {
		if !strings.Contains(shown, part) {
			t.Errorf("message lacks %q: %q", part, shown)
		}
	}
	layout := f.installer.Layout
	if exists(layout.ConfigDir) || exists(layout.StateDir) || exists(layout.ProgramDir) {
		t.Fatal("folders left after failures elsewhere")
	}
}

func TestUninstallCancelledChangesNothing(t *testing.T) {
	f := installedFixture(t)
	f.dialogs.answers = []bool{false}
	if code := f.installer.Uninstall(context.Background(), f.installer.Layout.Exe(), false); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if len(f.revoked) != 0 || !exists(f.installer.Layout.Exe()) || len(f.registry.values) == 0 {
		t.Fatal("cancelled uninstall changed something")
	}
}

func TestUninstallNeverRemovesForeignFolders(t *testing.T) {
	f := installedFixture(t)
	foreign := filepath.Join(f.home, "Documents")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatal(err)
	}
	f.installer.Layout.ConfigDir = foreign
	if code := f.installer.Uninstall(context.Background(), f.installer.Layout.Exe(), true); code != 1 {
		t.Fatalf("code = %d", code)
	}
	if !exists(foreign) {
		t.Fatal("a folder not named for AIQSA Connect was removed")
	}
}
