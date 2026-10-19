package main

import "fmt"

func init() {
	register(command{
		name:    "version",
		usage:   "version",
		summary: "Print the client version",
		run:     runVersion,
	})
}

func runVersion(inv *invocation) int {
	if len(inv.args) > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect version")
		return 2
	}
	fmt.Fprintln(inv.stdout, version)
	return 0
}
