package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
)

func init() {
	register(command{
		name:    "logout",
		usage:   "logout",
		summary: "Disconnect this computer from AIQSA and remove its credentials",
		run:     runLogout,
	})
}

// logoutRevokeTimeout bounds the self-revoke; the credentials are removed
// either way.
var logoutRevokeTimeout = 15 * time.Second

// newRevokeClient is the device API logout revokes through; tests replace it.
var newRevokeClient = func(creds config.Credentials) interface{ RevokeSelf(context.Context) error } {
	return api.New(creds.Origin, creds.DeviceToken, version)
}

// runLogout revokes this device in AIQSA (spec D-16), then removes the
// local credentials, also when AIQSA cannot be reached.
func runLogout(inv *invocation) int {
	if len(inv.args) > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect logout")
		return 2
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect logout: %v\n", err)
		return 1
	}
	creds, loadErr := paths.LoadCredentials()
	if errors.Is(loadErr, config.ErrNotLoggedIn) {
		fmt.Fprintln(inv.stdout, "This computer is not logged in.")
		return 0
	}
	var revokeErr error
	if loadErr == nil {
		ctx, cancel := context.WithTimeout(inv.ctx, logoutRevokeTimeout)
		revokeErr = newRevokeClient(creds).RevokeSelf(ctx)
		cancel()
	}
	if _, err := paths.RemoveCredentials(); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect logout: cannot remove the credentials: %v\n", err)
		return 1
	}
	switch {
	case loadErr != nil:
		fmt.Fprintln(inv.stdout, "Removed this computer's unreadable AIQSA credentials.")
		fmt.Fprintln(inv.stdout, "If the computer is still listed in AIQSA → AIQSA Connect, remove it there.")
	case revokeErr != nil:
		fmt.Fprintf(inv.stdout, "Removed this computer's AIQSA credentials, but %s.\n", describeAPIError(creds.Origin, revokeErr))
		fmt.Fprintln(inv.stdout, "The computer is still listed in AIQSA: remove it in AIQSA → AIQSA Connect. A running aiqsa-connect up keeps its connection until it stops.")
	default:
		fmt.Fprintf(inv.stdout, "Disconnected this computer from %s and removed its credentials.\n", creds.Origin)
	}
	return 0
}
