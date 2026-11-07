package winapp

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/logx"
)

func TestInstallRefreshAndSwitchCreateTheStartMenuShortcut(t *testing.T) {
	f := newInstallFixture(t)
	layout := f.installer.Layout
	link := filepath.Join(f.home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "AIQSA Connect.lnk")
	if layout.Shortcut() != link {
		t.Fatalf("shortcut %q", layout.Shortcut())
	}
	wantLink := layout.Exe() + "|" + layout.ProgramDir + "|AIQSA Connect"

	f.dialogs.answers = []bool{true}
	self := f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1")
	if code := f.installer.Launch(context.Background(), self); code != 0 {
		t.Fatalf("install: %d %q", code, f.dialogs.shown)
	}
	if readString(t, link) != wantLink {
		t.Fatalf("install: link %q", readString(t, link))
	}

	// Running the download again (refresh) restores a deleted shortcut.
	os.Remove(link)
	if code := f.installer.Launch(context.Background(), self); code != 0 || readString(t, link) != wantLink {
		t.Fatalf("refresh: %d", code)
	}

	// So does a switch to another AIQSA.
	os.Remove(link)
	f.dialogs.answers = []bool{true}
	if code := f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.other.example.exe", "program v1")); code != 0 || readString(t, link) != wantLink {
		t.Fatalf("switch: %d", code)
	}
	if len(f.shortcuts.created) != 3 {
		t.Fatalf("created %v", f.shortcuts.created)
	}
	// Only the shortcut, directly in the Programs folder; no desktop shortcut.
	if entries, _ := os.ReadDir(layout.StartMenuDir); len(entries) != 1 {
		t.Fatalf("Start menu folder holds %d entries", len(entries))
	}
}

func TestAShortcutFailureDoesNotFailTheInstall(t *testing.T) {
	f := newInstallFixture(t)
	f.shortcuts.err = errors.New("Access is denied.")
	f.dialogs.answers = []bool{true}
	if code := f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1")); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	if len(f.shortcuts.created) != 1 || len(f.dialogs.shown) != 0 {
		t.Fatalf("created %v, shown %q", f.shortcuts.created, f.dialogs.shown)
	}
	if f.registry.values[UninstallKey+`\DisplayVersion`] != "1.2.3" || f.journal.index("start aiqsa-connect.exe up --tray") == -1 {
		t.Fatalf("installation incomplete: %v %v", f.registry.keys(), f.journal.list())
	}
}

func TestNoShortcutWithoutAStartMenuFolder(t *testing.T) {
	f := newInstallFixture(t)
	f.installer.Layout.StartMenuDir = ""
	f.dialogs.answers = []bool{true}
	if code := f.installer.Launch(context.Background(), f.download(t, "AIQSA Connect - ai.example.com.exe", "program v1")); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if len(f.shortcuts.created) != 0 || f.installer.EnsureShortcut() != nil || len(f.shortcuts.created) != 0 {
		t.Fatalf("created %v", f.shortcuts.created)
	}
	if code := f.installer.Uninstall(context.Background(), f.installer.Layout.Exe(), true); code != 0 {
		t.Fatalf("uninstall: %d %q", code, f.dialogs.shown)
	}
}

func TestUninstallRemovesOnlyTheShortcut(t *testing.T) {
	f := installedFixture(t)
	layout := f.installer.Layout
	others := []string{filepath.Join(layout.StartMenuDir, "Other.lnk"), filepath.Join(layout.StartMenuDir, "AIQSA Connect", "AIQSA Connect.lnk")}
	for _, path := range others {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if !exists(layout.Shortcut()) {
		t.Fatal("no shortcut after install")
	}
	if code := f.installer.Uninstall(context.Background(), layout.Exe(), true); code != 0 {
		t.Fatalf("code = %d %q", code, f.dialogs.shown)
	}
	if exists(layout.Shortcut()) {
		t.Fatal("shortcut left")
	}
	for _, path := range others {
		if !exists(path) {
			t.Errorf("%s removed", path)
		}
	}
}

func TestUninstallWithoutTheShortcutOrFailingToRemoveIt(t *testing.T) {
	f := installedFixture(t)
	link := f.installer.Layout.Shortcut()
	// The user deleted it: nothing to report.
	os.Remove(link)
	if code := f.installer.Uninstall(context.Background(), f.installer.Layout.Exe(), true); code != 0 {
		t.Fatalf("missing shortcut: %d %q", code, f.dialogs.shown)
	}

	// Something in its place that cannot be removed is a problem to report.
	f = installedFixture(t)
	link = f.installer.Layout.Shortcut()
	os.Remove(link)
	if err := os.MkdirAll(filepath.Join(link, "inside"), 0o700); err != nil {
		t.Fatal(err)
	}
	if code := f.installer.Uninstall(context.Background(), f.installer.Layout.Exe(), true); code != 1 {
		t.Fatalf("code = %d", code)
	}
	shown := f.dialogs.shown[len(f.dialogs.shown)-1]
	if !strings.HasPrefix(shown, "AIQSA Connect was removed, with problems:") || !strings.Contains(shown, "The shortcut in the Start menu could not be removed") {
		t.Fatalf("shown %q", shown)
	}
	if exists(f.installer.Layout.ProgramDir) {
		t.Fatal("the rest was not removed")
	}
}

func TestAfterStartNotifiesAndRestoresTheShortcutOnlyAfterAnUpdate(t *testing.T) {
	f := installedFixture(t)
	in := f.installer
	link := in.Layout.Shortcut()
	var notices []string
	notify := func(text string) { notices = append(notices, text) }
	var logged bytes.Buffer
	log := logx.New(&logged)
	created := len(f.shortcuts.created)

	// An ordinary start: the user's deleted shortcut stays deleted.
	os.Remove(link)
	in.afterStart(context.Background(), notify, log, nil)
	if len(notices) != 0 || exists(link) || len(f.shortcuts.created) != created || logged.Len() != 0 {
		t.Fatalf("ordinary start: %q %v %q", notices, f.shortcuts.created, logged.String())
	}

	// After a self-update: Apps shows the new version, the shortcut is back
	// and the user is told once.
	in.Version = "1.3.0"
	in.afterStart(context.Background(), notify, log, nil)
	if !slices.Equal(notices, []string{"AIQSA Connect updated to 1.3.0."}) {
		t.Fatalf("notices %q", notices)
	}
	if f.registry.values[UninstallKey+`\DisplayVersion`] != "1.3.0" || !exists(link) {
		t.Fatal("entry or shortcut not refreshed")
	}
	for _, event := range []string{" apps_entry_refreshed\n", " update_notified\n"} {
		if !strings.Contains(logged.String(), event) {
			t.Errorf("log lacks %q: %q", event, logged.String())
		}
	}
	created = len(f.shortcuts.created)

	// The next start of the same version says nothing.
	in.afterStart(context.Background(), notify, log, nil)
	if len(notices) != 1 {
		t.Fatalf("notices %q", notices)
	}

	// Another update with the shortcut in place leaves it as it is.
	in.Version = "1.4.0"
	in.afterStart(context.Background(), notify, log, nil)
	if len(notices) != 2 || notices[1] != "AIQSA Connect updated to 1.4.0." || len(f.shortcuts.created) != created {
		t.Fatalf("notices %q, created %v", notices, f.shortcuts.created)
	}

	// A failing shortcut is logged and the notice still shows.
	os.Remove(link)
	f.shortcuts.err = errors.New("Access is denied.")
	in.Version = "1.5.0"
	in.afterStart(context.Background(), notify, log, nil)
	if len(notices) != 3 || !strings.Contains(logged.String(), " shortcut_create_failed ") {
		t.Fatalf("notices %q, log %q", notices, logged.String())
	}
}
