package winapp

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/update"
)

// The installed program's own settings, which its tray changes.

// StartsAtSignIn reports whether the start at sign-in is registered and
// points at the installed program.
func (in *Installer) StartsAtSignIn() bool {
	command, err := in.Registry.String(RunKey, RunValue)
	return err == nil && samePath(commandProgram(command), in.Layout.Exe())
}

// SetStartAtSignIn writes the start at sign-in the installer registers,
// or removes only that value.
func (in *Installer) SetStartAtSignIn(on bool) error {
	if on {
		return in.Registry.SetString(RunKey, RunValue, in.Layout.runCommand())
	}
	return in.Registry.DeleteValue(RunKey, RunValue)
}

// StartUninstall starts the installed program's `uninstall` as a separate
// process: it asks the user, and when they agree it stops this tray and
// removes the program (Uninstall).
func (in *Installer) StartUninstall() error {
	return in.System.Start(in.Layout.Exe(), "uninstall")
}

// RefreshAppsEntry makes the version and size in Windows Apps those of the
// running program, as after a self-update: install and refresh write their
// own version, so a different one means a self-update replaced the program
// file. An entry that does not exist is not created. It returns the version
// the entry showed when it changed it, otherwise "".
func (in *Installer) RefreshAppsEntry() (previous string, err error) {
	if in.Version == "" {
		return "", nil
	}
	shown, err := in.Registry.String(UninstallKey, "DisplayVersion")
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil || shown == in.Version {
		return "", err
	}
	if err := in.Registry.SetString(UninstallKey, "DisplayVersion", in.Version); err != nil {
		return "", err
	}
	return shown, in.Registry.SetDWord(UninstallKey, "EstimatedSize", in.Layout.sizeKB())
}

// EnsureShortcut creates the Start menu shortcut when it is missing, so an
// installation made before shortcuts existed gets one with its next
// update. An existing file is left as it is.
func (in *Installer) EnsureShortcut() error {
	link := in.Layout.Shortcut()
	if link == "" {
		return nil
	}
	if _, err := os.Lstat(link); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return in.createShortcut()
}

// UpdatedNotice is the notification after a self-update to version.
func UpdatedNotice(version string) string {
	return truncateUTF16("AIQSA Connect updated to "+version+".", 255)
}

// AfterStart tidies the installed program once its tray has started and
// shows its icon. After a self-update (RefreshAppsEntry changed the Apps
// entry) the Start menu shortcut is created when missing and notify tells
// the user the new version; on ordinary starts neither happens, so a
// shortcut the user deleted stays deleted. Finally the file the update
// moved aside goes once the previous process has exited. Failures are only
// logged; the next start tries again.
func (in *Installer) AfterStart(ctx context.Context, notify func(string), log *logx.Logger) {
	in.afterStart(ctx, notify, log, StaleOldRetries)
}

func (in *Installer) afterStart(ctx context.Context, notify func(string), log *logx.Logger, retries []time.Duration) {
	previous, err := in.RefreshAppsEntry()
	if err != nil {
		log.Event("apps_entry_refresh_failed", "error", err)
	}
	if previous != "" {
		log.Event("apps_entry_refreshed")
		if err := in.EnsureShortcut(); err != nil {
			log.Event("shortcut_create_failed", "error", err)
		}
		notify(UpdatedNotice(in.Version))
		log.Event("update_notified")
	}
	RemoveStaleOldLater(ctx, in.Layout.Exe(), retries)
}

// commandProgram is the program of a command line: its first, possibly
// quoted, word.
func commandProgram(command string) string {
	command = strings.TrimSpace(command)
	if rest, ok := strings.CutPrefix(command, `"`); ok {
		program, _, closed := strings.Cut(rest, `"`)
		if !closed {
			return ""
		}
		return program
	}
	program, _, _ := strings.Cut(command, " ")
	return program
}

// StaleOldRetries are when, after the tray starts, it tries again to
// remove the file an update moved aside: at the start the previous
// process may still be exiting from it.
var StaleOldRetries = []time.Duration{5 * time.Second, 15 * time.Second, 60 * time.Second}

// RemoveStaleOldLater removes <exe>.old (update.OldPath) at each delay
// after its start until it is gone or ctx ends. It touches only that file
// and ignores failures: the next start tries again.
func RemoveStaleOldLater(ctx context.Context, exe string, after []time.Duration) {
	removeStaleOldLater(ctx, exe, after, os.Remove)
}

func removeStaleOldLater(ctx context.Context, exe string, after []time.Duration, remove func(string) error) {
	if exe == "" {
		return
	}
	old := update.OldPath(exe)
	start := time.Now()
	for _, delay := range after {
		if !regularFile(old) {
			return
		}
		timer := time.NewTimer(time.Until(start.Add(delay)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if regularFile(old) && remove(old) == nil {
			return
		}
	}
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}
