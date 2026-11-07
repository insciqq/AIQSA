package winapp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/state"
)

func menuIDs(view View) []MenuID {
	ids := make([]MenuID, 0, len(view.Menu))
	for _, item := range view.Menu {
		ids = append(ids, item.ID)
	}
	return ids
}

func menuItem(t *testing.T, view View, id MenuID) MenuItem {
	t.Helper()
	for _, item := range view.Menu {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("no item %d in %+v", id, view.Menu)
	return MenuItem{}
}

func TestInstalledItemsOnlyForTheInstalledCopy(t *testing.T) {
	for _, kind := range state.Kinds {
		s := state.State{Kind: kind, Origin: testOrigin, UserCode: "ABCD-EFGH"}
		if view := ViewOf(s, AppItems{}); hasItem(view, MenuStartAtSignIn) || hasItem(view, MenuUninstall) {
			t.Errorf("%s: a copy outside the installed location offers %+v", kind, view.Menu)
		}
		for _, on := range []bool{false, true} {
			view := ViewOf(s, AppItems{Installed: true, StartAtSignIn: on})
			start := menuItem(t, view, MenuStartAtSignIn)
			if start.Label != "Start at sign-in" || !start.Enabled || start.Checked != on {
				t.Errorf("%s: start at sign-in %+v", kind, start)
			}
			last := view.Menu[len(view.Menu)-1]
			if last.ID != MenuUninstall || last.Label != "Uninstall AIQSA Connect…" || !last.Enabled || last.Checked {
				t.Errorf("%s: last item %+v", kind, last)
			}
		}
	}
	got := menuIDs(ViewOf(state.State{Kind: state.Connected, Origin: testOrigin}, AppItems{Installed: true}))
	want := []MenuID{MenuStatus, MenuSeparator, MenuOpen, MenuDisconnect, MenuSeparator, MenuStartAtSignIn,
		MenuSeparator, MenuVersion, MenuQuit, MenuSeparator, MenuUninstall}
	if !slices.Equal(got, want) {
		t.Fatalf("menu %v, want %v", got, want)
	}
}

// installedController is a tray of the installed copy over the fakes.
func installedController(t *testing.T) (*Controller, *installFixture, *fakeUI) {
	t.Helper()
	f := newInstallFixture(t)
	ui := newFakeUI()
	return &Controller{Origin: testOrigin, UI: ui, Installed: f.installer}, f, ui
}

func (f *installFixture) runCommand() string {
	return `"` + f.installer.Layout.Exe() + `" up --tray`
}

func TestStartAtSignInCheckMarkFollowsTheRegistry(t *testing.T) {
	c, f, _ := installedController(t)
	if got := (&Controller{UI: newFakeUI()}).AppItems(); got != (AppItems{}) {
		t.Fatalf("copy outside the installed location: %+v", got)
	}
	cases := []struct {
		value   string
		checked bool
	}{
		{"", false},
		{f.runCommand(), true},
		{`"` + strings.ToUpper(f.installer.Layout.Exe()) + `" up --tray`, true},
		{`"` + f.installer.Layout.Exe() + `"`, true},
		{`"C:\Other\aiqsa-connect.exe" up --tray`, false},
		{f.installer.Layout.Exe() + " up --tray", false}, // unquoted, the folder has a space
		{`"` + f.installer.Layout.Exe(), false},
	}
	for _, tc := range cases {
		delete(f.registry.values, RunKey+`\`+RunValue)
		if tc.value != "" {
			f.registry.values[RunKey+`\`+RunValue] = tc.value
		}
		if got := c.AppItems(); got != (AppItems{Installed: true, StartAtSignIn: tc.checked}) {
			t.Errorf("%q: %+v", tc.value, got)
		}
	}
}

func TestStartAtSignInToggleWritesOnlyTheRunValue(t *testing.T) {
	c, f, ui := installedController(t)
	c.Do(MenuStartAtSignIn)
	if got := f.registry.keys(); !slices.Equal(got, []string{RunKey + `\` + RunValue}) {
		t.Fatalf("turned on: %v", got)
	}
	if got, _ := f.registry.String(RunKey, RunValue); got != f.runCommand() {
		t.Fatalf("run value %q", got)
	}
	if !c.AppItems().StartAtSignIn {
		t.Fatal("not checked after turning on")
	}
	// The Apps entry and anything else stay when it is turned off.
	f.registry.values[UninstallKey+`\DisplayVersion`] = "1.2.3"
	f.registry.values[RunKey+`\Other`] = "other.exe"
	c.Do(MenuStartAtSignIn)
	if got := f.registry.keys(); !slices.Equal(got, []string{RunKey + `\Other`, UninstallKey + `\DisplayVersion`}) {
		t.Fatalf("turned off: %v", got)
	}
	if got := f.journal.list(); !slices.Equal(got, []string{"registry delete value AIQSA Connect"}) {
		t.Fatalf("journal %v", got)
	}
	if c.AppItems().StartAtSignIn || len(ui.warnings) != 0 {
		t.Fatalf("after turning off: %+v %v", c.AppItems(), ui.warnings)
	}
}

func TestStartAtSignInFailureKeepsTheState(t *testing.T) {
	c, f, ui := installedController(t)
	f.registry.fail["set"] = errors.New("Access is denied.")
	c.Do(MenuStartAtSignIn)
	if len(f.registry.keys()) != 0 || c.AppItems().StartAtSignIn {
		t.Fatalf("failed turning on changed %v", f.registry.keys())
	}
	if len(ui.warnings) != 1 || ui.warnings[0] != "Start at sign-in could not be turned on: Access is denied." {
		t.Fatalf("warnings %q", ui.warnings)
	}

	delete(f.registry.fail, "set")
	f.registry.values[RunKey+`\`+RunValue] = f.runCommand()
	f.registry.fail["value"] = errors.New("Access is denied.")
	c.Do(MenuStartAtSignIn)
	if !c.AppItems().StartAtSignIn {
		t.Fatal("failed turning off cleared the check mark")
	}
	if len(ui.warnings) != 2 || ui.warnings[1] != "Start at sign-in could not be turned off: Access is denied." {
		t.Fatalf("warnings %q", ui.warnings)
	}
}

func TestUninstallItemStartsTheInstalledUninstall(t *testing.T) {
	c, f, ui := installedController(t)
	c.Do(MenuUninstall)
	want := [][]string{{f.installer.Layout.Exe(), "uninstall"}}
	if !slices.EqualFunc(f.system.started, want, slices.Equal[[]string]) {
		t.Fatalf("started %q", f.system.started)
	}
	// The tray itself does nothing more: the removal asks and stops it.
	if got := f.journal.list(); !slices.Equal(got, []string{"start aiqsa-connect.exe uninstall"}) || len(ui.warnings) != 0 {
		t.Fatalf("journal %v warnings %v", got, ui.warnings)
	}
	select {
	case <-ui.exited:
		t.Fatal("the tray exited before the removal was confirmed")
	default:
	}

	f.system.startErr = errors.New("The system cannot find the file specified.")
	c.Do(MenuUninstall)
	if len(ui.warnings) != 1 || !strings.HasPrefix(ui.warnings[0], "The removal of AIQSA Connect could not start: ") {
		t.Fatalf("warnings %q", ui.warnings)
	}

	other := &Controller{UI: newFakeUI()}
	other.Do(MenuUninstall)
	other.Do(MenuStartAtSignIn)
}

func TestRefreshAppsEntryShowsTheRunningVersion(t *testing.T) {
	f := newInstallFixture(t)
	in := f.installer
	if previous, err := in.RefreshAppsEntry(); previous != "" || err != nil || len(f.registry.keys()) != 0 {
		t.Fatalf("created an entry: %q %v %v", previous, err, f.registry.keys())
	}
	if err := os.MkdirAll(in.Layout.ProgramDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(in.Layout.Exe(), make([]byte, 3000), 0o755); err != nil {
		t.Fatal(err)
	}
	in.Version = "1.0.0"
	if err := in.register(); err != nil {
		t.Fatal(err)
	}
	before := f.registry.keys()
	if previous, err := in.RefreshAppsEntry(); previous != "" || err != nil {
		t.Fatalf("same version: %q %v", previous, err)
	}

	// A self-update replaced the program.
	if err := os.WriteFile(in.Layout.Exe(), make([]byte, 5000), 0o755); err != nil {
		t.Fatal(err)
	}
	in.Version = "1.2.3"
	if previous, err := in.RefreshAppsEntry(); previous != "1.0.0" || err != nil {
		t.Fatalf("new version: %q %v", previous, err)
	}
	if got := f.registry.values[UninstallKey+`\DisplayVersion`]; got != "1.2.3" {
		t.Fatalf("DisplayVersion %v", got)
	}
	if got := f.registry.values[UninstallKey+`\EstimatedSize`]; got != uint32(5) {
		t.Fatalf("EstimatedSize %v", got)
	}
	if got := f.registry.keys(); !slices.Equal(got, before) {
		t.Fatalf("values %v, before %v", got, before)
	}

	in.Version = "1.2.4"
	f.registry.fail["set"] = errors.New("Access is denied.")
	if previous, err := in.RefreshAppsEntry(); previous != "" || err == nil {
		t.Fatalf("failed write: %q %v", previous, err)
	}
	if got := f.registry.values[UninstallKey+`\DisplayVersion`]; got != "1.2.3" {
		t.Fatalf("DisplayVersion %v", got)
	}
}

func TestStaleOldRetryRemovesOnlyThatFile(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, ExeName)
	keep := []string{exe, exe + ".new", exe + ".old.txt", filepath.Join(dir, "other.exe.old")}
	for _, path := range append(keep, exe+".old") {
		if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	RemoveStaleOldLater(context.Background(), exe, []time.Duration{time.Millisecond})
	if exists(exe + ".old") {
		t.Fatal("the stale file is still there")
	}
	for _, path := range keep {
		if !exists(path) {
			t.Fatalf("%s was removed", filepath.Base(path))
		}
	}

	// A folder of that name is not the program's file.
	if err := os.Mkdir(exe+".old", 0o755); err != nil {
		t.Fatal(err)
	}
	RemoveStaleOldLater(context.Background(), exe, []time.Duration{time.Millisecond})
	if !exists(exe + ".old") {
		t.Fatal("a folder was removed")
	}
}

func TestStaleOldRetryTriesAgainUntilRemoved(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, ExeName)
	if err := os.WriteFile(exe+".old", []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	var tried []string
	remove := func(path string) error {
		tried = append(tried, path)
		if len(tried) < 3 {
			return errors.New("The process cannot access the file because it is being used by another process.")
		}
		return os.Remove(path)
	}
	start := time.Now()
	removeStaleOldLater(context.Background(), exe, []time.Duration{time.Millisecond, 10 * time.Millisecond, 20 * time.Millisecond, time.Hour}, remove)
	if len(tried) != 3 || exists(exe+".old") || time.Since(start) < 20*time.Millisecond {
		t.Fatalf("tried %d times in %v", len(tried), time.Since(start))
	}
	for _, path := range tried {
		if path != exe+".old" {
			t.Fatalf("removed %s", path)
		}
	}

	// Nothing to remove: no wait; an ended start: no attempt.
	tried = nil
	start = time.Now()
	removeStaleOldLater(context.Background(), exe, []time.Duration{time.Hour}, remove)
	if len(tried) != 0 || time.Since(start) > time.Minute {
		t.Fatalf("tried %d", len(tried))
	}
	if err := os.WriteFile(exe+".old", []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	removeStaleOldLater(ctx, exe, []time.Duration{time.Hour}, remove)
	if len(tried) != 0 || !exists(exe+".old") {
		t.Fatalf("tried %d after the end", len(tried))
	}
}
