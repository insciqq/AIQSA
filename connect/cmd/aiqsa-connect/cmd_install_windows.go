//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/update"
	"github.com/insciqq/AIQSA/connect/internal/winapp"
)

// The Windows entry (spec D-12): a start from a console attaches to it so
// the commands print; a start without arguments installs, updates or
// switches the installation, or opens AIQSA; `up --tray` is the program
// started at sign-in.
func init() {
	platformInit = func(args []string) {
		if len(args) > 0 && !isTrayArgs(args) {
			winapp.AttachParentConsole()
		}
		// The file an update moved aside, once its process has exited.
		update.RemoveStaleOld(selfExecutable())
	}
	launchWithoutArguments = runLaunch
	trayCommand = runTray
}

func runLaunch(inv *invocation) int {
	installer, err := newInstaller()
	if err != nil {
		winapp.WindowsDialogs{}.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot start: %v", err))
		return 1
	}
	return installer.Launch(inv.ctx, selfExecutable())
}

// windowsLayout places the program under %LOCALAPPDATA%\Programs beside the
// client's config and state folders.
func windowsLayout(paths config.Paths) (winapp.Layout, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(localAppData) {
		dir, err := os.UserCacheDir() // %LocalAppData% on Windows
		if err != nil {
			return winapp.Layout{}, errors.New("cannot determine the local application data folder")
		}
		localAppData = dir
	}
	return winapp.NewLayout(localAppData, os.TempDir(), paths)
}

func newInstaller() (*winapp.Installer, error) {
	paths, err := config.ResolvePaths()
	if err != nil {
		return nil, err
	}
	layout, err := windowsLayout(paths)
	if err != nil {
		return nil, err
	}
	return &winapp.Installer{
		Layout:   layout,
		Registry: winapp.WindowsRegistry{},
		System:   winapp.WindowsSystem{},
		Dialogs:  winapp.WindowsDialogs{},
		Version:  version,
		Revoke:   revokeDevice,
	}, nil
}

// revokeDevice deletes the device of creds in AIQSA (spec D-16).
func revokeDevice(ctx context.Context, creds config.Credentials) error {
	return api.New(creds.Origin, creds.DeviceToken, version).RevokeSelf(ctx)
}

// restartProcess starts the updated program with the same arguments,
// detached, and returns; this process then exits (spec D-14). The new tray
// waits for this one's single-instance mutex.
func restartProcess(path string, argv, env []string) error {
	cmd := exec.Command(path, argv[1:]...)
	cmd.Env = env
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		cmd.Dir = home
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
