package main

import (
	"fmt"

	"github.com/insciqq/AIQSA/connect/internal/config"
)

func init() {
	register(command{
		name:    "logout",
		usage:   "logout",
		summary: "Remove this computer's AIQSA credentials",
		run:     runLogout,
	})
}

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
	removed, err := paths.RemoveCredentials()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect logout: %v\n", err)
		return 1
	}
	if !removed {
		fmt.Fprintln(inv.stdout, "This computer is not logged in.")
	} else {
		fmt.Fprintln(inv.stdout, "Removed this computer's AIQSA credentials. A running aiqsa-connect up keeps its connection until it stops.")
	}
	fmt.Fprintln(inv.stdout, "Also revoke this computer in AIQSA → AIQSA Connect so its token stops working. Your tmux sessions keep running.")
	return 0
}
