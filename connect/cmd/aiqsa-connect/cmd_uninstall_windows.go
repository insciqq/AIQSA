//go:build windows

package main

import (
	"fmt"
	"os"

	"github.com/insciqq/AIQSA/connect/internal/winapp"
)

func init() {
	register(command{
		name:    "uninstall",
		usage:   "uninstall [--yes]",
		summary: "Remove AIQSA Connect from this computer (Windows Apps runs it)",
		run:     runUninstall,
	})
}

const uninstallUsage = "Usage: aiqsa-connect uninstall [--yes]"

func runUninstall(inv *invocation) int {
	confirmed := false
	for _, arg := range inv.args {
		if arg != "--yes" || confirmed {
			fmt.Fprintln(inv.stderr, uninstallUsage)
			return 2
		}
		confirmed = true
	}
	installer, err := newInstaller()
	if err != nil {
		winapp.WindowsDialogs{}.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot be removed: %v", err))
		return 1
	}
	// A current folder inside the program folder would keep it from being removed.
	os.Chdir(installer.Layout.TempDir)
	return installer.Uninstall(inv.ctx, selfExecutable(), confirmed)
}
