//go:build windows

package main

// The tray's coupling to the daemon and the login helpers of
// connect-client-ops, kept in this one file: daemon.Options.OnState and
// Run, daemon.ErrRevoked/ErrReplaced, platform() and deviceNames() from
// cmd_login.go, retireRevokedCredentials() from cmd_up.go.

import (
	"context"
	"errors"
	"io"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/state"
	"github.com/insciqq/AIQSA/connect/internal/winapp"
)

// trayDevice is what a tray pairing tells AIQSA about this computer.
func trayDevice() (winapp.Device, error) {
	osName, arch, err := platform()
	if err != nil {
		return winapp.Device{}, err
	}
	name, hostname, err := deviceNames("")
	if err != nil {
		return winapp.Device{}, err
	}
	return winapp.Device{Name: name, Hostname: hostname, OS: osName, Arch: arch}, nil
}

// trayDaemon runs the daemon for the tray, reporting its states, and turns
// its final stops into the tray's: a revoked device's credentials are set
// aside as `up` does, and an installed update restarts the program.
func trayDaemon(paths config.Paths, logger func() *logx.Logger) winapp.DaemonFunc {
	return func(ctx context.Context, creds config.Credentials, sink state.Sink) error {
		log := logger()
		runCtx, stop := context.WithCancel(ctx)
		defer stop()
		binder, _ := updater.(upBinder)
		if binder != nil {
			binder.bindUp(runCtx, stop, creds.Origin, log, io.Discard)
		}
		d, err := daemon.New(daemon.Options{
			Credentials: creds,
			Paths:       paths,
			Version:     version,
			Log:         log,
			Updater:     updater,
			Notices:     io.Discard,
			OnState:     sink,
		})
		if err != nil {
			return err
		}
		err = d.Run(runCtx)
		if err == nil && ctx.Err() == nil && binder != nil {
			if code, restarted := binder.restartUpdated(io.Discard); restarted {
				if code == 0 {
					return winapp.ErrRestarting
				}
				return errors.New("cannot restart the updated client")
			}
		}
		switch {
		case errors.Is(err, daemon.ErrRevoked):
			retireRevokedCredentials(paths, creds)
			return winapp.ErrRevoked
		case errors.Is(err, daemon.ErrReplaced):
			return winapp.ErrReplaced
		}
		return err
	}
}
