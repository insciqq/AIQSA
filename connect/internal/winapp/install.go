package winapp

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/update"
)

// RevokeTimeout bounds the self-revoke of switch and uninstall: they go on
// when AIQSA cannot be reached.
const RevokeTimeout = 15 * time.Second

// StopTimeout bounds waiting for a running tray instance to quit.
const StopTimeout = 15 * time.Second

// Installer installs, switches and removes the program for the current
// user (spec §9). Every outside effect goes through its fields.
type Installer struct {
	Layout   Layout
	Registry Registry
	System   System
	Dialogs  Dialogs
	// Shortcuts creates the Start menu shortcut; nil creates none.
	Shortcuts Shortcuts
	// Version is this program's version, shown in Windows Apps.
	Version string
	// Revoke deletes the device of creds in AIQSA (api.Client.RevokeSelf).
	Revoke func(ctx context.Context, creds config.Credentials) error
}

// Texts of the dialogs (spec §9).
const (
	downloadAgainText = "This file does not say which AIQSA it belongs to. Download AIQSA Connect again from your AIQSA page."
	installTextFormat = "Install AIQSA Connect for %s?\n\nIt lets the AIQSA agent work with files and run commands on this computer with your permissions.\n\nSelect OK to install."
	switchTextFormat  = "Switch AIQSA Connect to %s?\n\nThis computer is disconnected from %s and connects to %s instead. The AIQSA agent of %s can then work with files and run commands on this computer with your permissions."
	uninstallText     = "Remove AIQSA Connect from this computer?\n\nThe AIQSA agent can then no longer work on this computer, and the computer is removed from AIQSA."
)

// Launch is a start without arguments: a double-click on the downloaded
// file or on the installed program. self is this program's own path. It
// installs, updates or switches the installation, or opens AIQSA.
func (in *Installer) Launch(ctx context.Context, self string) int {
	if samePath(self, in.Layout.Exe()) {
		return in.openOrStart()
	}
	origin, err := OriginFromFileName(self)
	if err != nil {
		in.Dialogs.Warn(AppName, downloadAgainText)
		return 1
	}
	installed := in.installedOrigin()
	switch {
	case installed == "":
		if !in.Dialogs.Confirm("Install "+AppName, fmt.Sprintf(installTextFormat, Host(origin))) {
			return 0
		}
		return in.finish(in.install(ctx, self, origin))
	case installed == origin:
		return in.finish(in.refresh(ctx, self, origin))
	}
	text := fmt.Sprintf(switchTextFormat, Host(origin), Host(installed), Host(origin), Host(origin))
	if !in.Dialogs.Confirm("Switch "+AppName, text) {
		return 0
	}
	return in.finish(in.switchTo(ctx, self, origin))
}

func (in *Installer) finish(err error) int {
	if err != nil {
		in.Dialogs.Warn(AppName, fmt.Sprintf("AIQSA Connect could not be installed: %v", err))
		return 1
	}
	return 0
}

// installedOrigin is the origin of an existing installation, or empty.
func (in *Installer) installedOrigin() string {
	if _, err := os.Stat(in.Layout.Exe()); err != nil {
		return ""
	}
	if origin := in.Layout.LoadOrigin(); origin != "" {
		return origin
	}
	if creds, err := in.Layout.Paths().LoadCredentials(); err == nil {
		return creds.Origin
	}
	return ""
}

// openOrStart is the installed program started without arguments: open
// AIQSA when the tray runs, otherwise start the tray.
func (in *Installer) openOrStart() int {
	if !in.System.Running() {
		if err := in.System.Start(in.Layout.Exe(), TrayArgs...); err != nil {
			in.Dialogs.Warn(AppName, fmt.Sprintf("AIQSA Connect could not start: %v", err))
			return 1
		}
		return 0
	}
	return in.openAIQSA()
}

func (in *Installer) openAIQSA() int {
	origin := in.installedOrigin()
	if origin == "" {
		return 0
	}
	if err := in.System.OpenURL(origin); err != nil {
		in.Dialogs.Warn(AppName, fmt.Sprintf("Cannot open %s: %v", Host(origin), err))
		return 1
	}
	return 0
}

// install places the program, records the origin, registers autostart and
// the Apps entry and starts the tray, which pairs the computer.
func (in *Installer) install(ctx context.Context, self, origin string) error {
	if in.System.Running() {
		if err := in.System.StopRunning(ctx); err != nil {
			return err
		}
	}
	if err := in.placeProgram(self); err != nil {
		return err
	}
	if err := in.Layout.SaveOrigin(origin); err != nil {
		return fmt.Errorf("cannot save the AIQSA address: %w", err)
	}
	if err := in.register(); err != nil {
		return err
	}
	return in.System.Start(in.Layout.Exe(), TrayArgs...)
}

// refresh runs the downloaded file of the installed origin again: a newer
// file replaces the installed one (the tray restarts), then AIQSA opens.
func (in *Installer) refresh(ctx context.Context, self, origin string) error {
	same, err := sameContent(self, in.Layout.Exe())
	if err != nil {
		return err
	}
	running := in.System.Running()
	if !same {
		if running {
			if err := in.System.StopRunning(ctx); err != nil {
				return err
			}
			running = false
		}
		if err := in.placeProgram(self); err != nil {
			return err
		}
	}
	if err := in.Layout.SaveOrigin(origin); err != nil {
		return fmt.Errorf("cannot save the AIQSA address: %w", err)
	}
	if err := in.register(); err != nil {
		return err
	}
	if !running {
		if err := in.System.Start(in.Layout.Exe(), TrayArgs...); err != nil {
			return err
		}
	}
	// A tray started without credentials opens the approval page itself.
	if _, err := in.Layout.Paths().LoadCredentials(); err == nil || running {
		if err := in.System.OpenURL(origin); err != nil {
			return fmt.Errorf("cannot open %s: %w", Host(origin), err)
		}
	}
	return nil
}

// switchTo moves the installation to another origin: the running tray
// stops, the old device is revoked (best effort) and forgotten, and the
// program is installed for origin, which pairs again.
func (in *Installer) switchTo(ctx context.Context, self, origin string) error {
	if in.System.Running() {
		if err := in.System.StopRunning(ctx); err != nil {
			return err
		}
	}
	notice := in.forgetDevice(ctx)
	if err := in.install(ctx, self, origin); err != nil {
		return err
	}
	if notice != "" {
		in.Dialogs.Inform(AppName, notice)
	}
	return nil
}

// forgetDevice revokes the stored device and removes its credentials. It
// returns a notice when AIQSA could not be told.
func (in *Installer) forgetDevice(ctx context.Context) string {
	paths := in.Layout.Paths()
	creds, err := paths.LoadCredentials()
	notice := ""
	if err == nil {
		revokeCtx, cancel := context.WithTimeout(ctx, RevokeTimeout)
		if err := in.Revoke(revokeCtx, creds); err != nil {
			notice = fmt.Sprintf("AIQSA at %s could not be reached, so this computer is still listed there. Remove it in AIQSA → AIQSA Connect.", Host(creds.Origin))
		}
		cancel()
	}
	if errors.Is(err, config.ErrNotLoggedIn) {
		return ""
	}
	// Damaged or unreadable credentials are removed too.
	paths.RemoveCredentials()
	return notice
}

// Uninstall removes the program (spec §9 step 7): after the user confirms
// (unless confirmed), it revokes this computer in AIQSA (going on when that
// fails), stops the running instance, removes the registry values and the
// config and state folders, and finally the program folder. self is this
// program's path: when it runs from the program folder, it is moved to the
// temporary folder first, because Windows cannot delete a running program.
func (in *Installer) Uninstall(ctx context.Context, self string, confirmed bool) int {
	if !confirmed && !in.Dialogs.Confirm("Remove "+AppName, uninstallText) {
		return 0
	}
	var problems []string
	if notice := in.forgetDevice(ctx); notice != "" {
		problems = append(problems, notice)
	}
	if err := in.System.StopRunning(ctx); err != nil {
		problems = append(problems, fmt.Sprintf("The running AIQSA Connect could not be stopped: %v.", err))
	}
	if err := in.Registry.DeleteValue(RunKey, RunValue); err != nil {
		problems = append(problems, fmt.Sprintf("The start at sign-in could not be removed: %v.", err))
	}
	if err := in.Registry.DeleteKey(UninstallKey); err != nil {
		problems = append(problems, fmt.Sprintf("The entry in Apps could not be removed: %v.", err))
	}
	if err := in.removeShortcut(); err != nil {
		problems = append(problems, fmt.Sprintf("The shortcut in the Start menu could not be removed: %v.", err))
	}
	for _, dir := range []string{in.Layout.ConfigDir, in.Layout.StateDir} {
		if err := removeOwnFolder(dir); err != nil {
			problems = append(problems, fmt.Sprintf("A folder could not be removed: %v.", err))
		}
	}
	if err := in.removeProgram(self); err != nil {
		problems = append(problems, fmt.Sprintf("The program folder could not be removed: %v.", err))
	}
	if len(problems) > 0 {
		in.Dialogs.Warn(AppName, "AIQSA Connect was removed, with problems:\n\n"+strings.Join(problems, "\n"))
		return 1
	}
	in.Dialogs.Inform(AppName, "AIQSA Connect was removed from this computer.")
	return 0
}

// removeProgram deletes the program folder. A program running from it
// (Windows Apps starts the installed copy to uninstall) is moved to the
// temporary folder first: a running file can be renamed, not deleted, and
// the temporary folder is cleaned by Windows.
func (in *Installer) removeProgram(self string) error {
	dir := in.Layout.ProgramDir
	if !ownFolder(dir) {
		return fmt.Errorf("%s is not a folder of AIQSA Connect; it was left in place", dir)
	}
	if self != "" && samePath(filepath.Dir(self), dir) {
		suffix := make([]byte, 6)
		rand.Read(suffix)
		aside := filepath.Join(in.Layout.TempDir, "aiqsa-connect-removed-"+hex.EncodeToString(suffix)+".exe")
		if err := os.Rename(self, aside); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	err := os.RemoveAll(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// placeProgram copies self into the program folder. An installed copy
// that is running is moved aside (update.SwapIn), as a self-update does.
func (in *Installer) placeProgram(self string) error {
	if err := os.MkdirAll(in.Layout.ProgramDir, 0o755); err != nil {
		return fmt.Errorf("cannot create the program folder: %w", err)
	}
	exe := in.Layout.Exe()
	staged := update.NewPath(exe)
	if err := copyFile(self, staged); err != nil {
		os.Remove(staged)
		return fmt.Errorf("cannot copy the program: %w", err)
	}
	if err := update.SwapIn(staged, exe); err != nil {
		os.Remove(staged)
		return err
	}
	update.RemoveStaleOld(exe)
	return nil
}

// register writes the start at sign-in, the Windows Apps entry and the
// Start menu shortcut. The shortcut is a convenience: failing to create it
// does not fail the installation.
func (in *Installer) register() error {
	if err := in.registerEntries(); err != nil {
		return err
	}
	in.createShortcut()
	return nil
}

// createShortcut writes the Start menu shortcut to the installed program,
// replacing one that exists. It does nothing without Shortcuts or a known
// Start menu folder.
func (in *Installer) createShortcut() error {
	link := in.Layout.Shortcut()
	if in.Shortcuts == nil || link == "" {
		return nil
	}
	return in.Shortcuts.Create(link, in.Layout.Exe(), in.Layout.ProgramDir, AppName)
}

// removeShortcut deletes the Start menu shortcut, and only that file; a
// missing one is fine.
func (in *Installer) removeShortcut() error {
	link := in.Layout.Shortcut()
	if link == "" {
		return nil
	}
	if err := os.Remove(link); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// registerEntries writes the start at sign-in and the Windows Apps entry.
func (in *Installer) registerEntries() error {
	exe := in.Layout.Exe()
	if err := in.Registry.SetString(RunKey, RunValue, in.Layout.runCommand()); err != nil {
		return fmt.Errorf("cannot register the start at sign-in: %w", err)
	}
	sizeKB := in.Layout.sizeKB()
	strs := [][2]string{
		{"DisplayName", AppName},
		{"DisplayVersion", in.Version},
		{"Publisher", Publisher},
		{"DisplayIcon", exe + ",0"},
		{"InstallLocation", in.Layout.ProgramDir},
		{"UninstallString", quoteArg(exe) + " uninstall"},
	}
	for _, value := range strs {
		if err := in.Registry.SetString(UninstallKey, value[0], value[1]); err != nil {
			return fmt.Errorf("cannot register in Apps: %w", err)
		}
	}
	dwords := []struct {
		name  string
		value uint32
	}{{"NoModify", 1}, {"NoRepair", 1}, {"EstimatedSize", sizeKB}}
	for _, value := range dwords {
		if err := in.Registry.SetDWord(UninstallKey, value.name, value.value); err != nil {
			return fmt.Errorf("cannot register in Apps: %w", err)
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// sameContent reports whether two files hold the same bytes; a missing b
// differs.
func sameContent(a, b string) (bool, error) {
	infoA, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	infoB, err := os.Stat(b)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if infoA.Size() != infoB.Size() {
		return false, nil
	}
	sumA, err := fileSum(a)
	if err != nil {
		return false, err
	}
	sumB, err := fileSum(b)
	if err != nil {
		return false, err
	}
	return bytes.Equal(sumA, sumB), nil
}

func fileSum(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return nil, err
	}
	return hash.Sum(nil), nil
}
