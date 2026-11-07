//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/winapp"
)

// trayInstanceWait is how long a starting tray waits for another one to
// exit, as after a self-update, before it gives way to it.
const trayInstanceWait = 15 * time.Second

// runTray is `up --tray`: the program started at sign-in, in the
// notification area (spec O-06, §9 steps 4-6).
func runTray(inv *invocation) int {
	dialogs := winapp.WindowsDialogs{}
	paths, err := config.ResolvePaths()
	if err != nil {
		dialogs.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot start: %v", err))
		return 1
	}
	layout, err := windowsLayout(paths)
	if err != nil {
		dialogs.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot start: %v", err))
		return 1
	}
	origin := layout.LoadOrigin()
	if creds, err := paths.LoadCredentials(); err == nil && origin == "" {
		origin = creds.Origin
	}
	device, err := trayDevice()
	if err != nil {
		dialogs.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot start: %v", err))
		return 1
	}

	var release func()
	log := logx.Discard()
	ready := func() bool {
		// On the tray's thread, which owns the mutex until the process exits.
		owned, err := winapp.AcquireSingleInstance(trayInstanceWait)
		if err != nil || !owned {
			return false // another tray runs
		}
		if err := paths.EnsureStateDir(); err != nil {
			dialogs.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot create its folder: %v", err))
			return false
		}
		release, err = daemon.AcquireLock(paths.LockFile())
		if errors.Is(err, daemon.ErrAlreadyRunning) {
			dialogs.Warn(winapp.AppName, "AIQSA Connect already runs in a terminal on this computer (aiqsa-connect up). Stop it there, then start AIQSA Connect again.")
			return false
		}
		if err != nil {
			dialogs.Warn(winapp.AppName, fmt.Sprintf("AIQSA Connect cannot start: %v", err))
			return false
		}
		if opened, err := logx.Open(paths.LogFile()); err == nil {
			log = opened
		}
		return true
	}

	ctx, cancel := context.WithCancel(inv.ctx)
	defer cancel()
	tray := &winapp.Tray{}
	controller := &winapp.Controller{
		Origin:  origin,
		Version: version,
		Device:  device,
		Paths:   paths,
		API: func(origin, token string) winapp.DeviceAPI {
			return api.New(origin, token, version)
		},
		Daemon: trayDaemon(paths, func() *logx.Logger { return log }),
		UI:     tray,
	}
	if layout.Runs(selfExecutable()) {
		controller.Installed = &winapp.Installer{
			Layout:   layout,
			Registry: winapp.WindowsRegistry{},
			System:   winapp.WindowsSystem{},
			Dialogs:  dialogs,
			Version:  version,
			Revoke:   revokeDevice,
		}
	}
	tray.Choose = controller.Choose
	tray.AppItems = controller.AppItems
	go func() {
		<-inv.ctx.Done()
		tray.Exit()
	}()
	err = tray.Run(ready, func() {
		controller.Start(ctx)
		if installed := controller.Installed; installed != nil {
			go maintainInstalled(ctx, installed, log)
		}
	})
	cancel()
	if release != nil {
		release()
	}
	log.Close()
	if err != nil {
		return 1
	}
	return 0
}

// maintainInstalled tidies the installed program after a start, as after a
// self-update: Windows Apps shows the running version, and the file the
// update moved aside goes once the previous process has exited. Failures
// are only logged; the next start tries again.
func maintainInstalled(ctx context.Context, installed *winapp.Installer, log *logx.Logger) {
	if changed, err := installed.RefreshAppsEntry(); err != nil {
		log.Event("apps_entry_refresh_failed", "error", err)
	} else if changed {
		log.Event("apps_entry_refreshed")
	}
	winapp.RemoveStaleOldLater(ctx, installed.Layout.Exe(), winapp.StaleOldRetries)
}
