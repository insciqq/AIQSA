package winapp

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

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
// running program, as after a self-update. An entry that does not exist is
// not created. It reports whether it changed the entry.
func (in *Installer) RefreshAppsEntry() (bool, error) {
	if in.Version == "" {
		return false, nil
	}
	shown, err := in.Registry.String(UninstallKey, "DisplayVersion")
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil || shown == in.Version {
		return false, err
	}
	if err := in.Registry.SetString(UninstallKey, "DisplayVersion", in.Version); err != nil {
		return false, err
	}
	return true, in.Registry.SetDWord(UninstallKey, "EstimatedSize", in.Layout.sizeKB())
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
