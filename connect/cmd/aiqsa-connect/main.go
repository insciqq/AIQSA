// Command aiqsa-connect connects this computer to an AIQSA installation so
// the AIQSA agent can work on it for its owner.
//
// Each subcommand lives in its own cmd_<name>.go file and registers itself
// from init(); main only dispatches. On Windows the program is also its own
// installer and tray application (cmd_install_windows.go,
// cmd_tray_windows.go): it is built with -H windowsgui, so a start without
// arguments shows windows instead of a console, and a start from a console
// attaches to it so the commands print.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"syscall"
)

// version is stamped at build time with -ldflags "-X main.version=<version>".
var version = "dev"

// invocation is what a subcommand receives: its own arguments and the
// process streams. ctx is cancelled on SIGINT or SIGTERM.
type invocation struct {
	ctx    context.Context
	args   []string
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

type command struct {
	name    string
	usage   string
	summary string
	run     func(inv *invocation) int
}

var commands = map[string]command{}

// Platform hooks, set from init() by the Windows files; nil elsewhere.
var (
	// platformInit runs first, before the process streams are used.
	platformInit func(args []string)
	// launchWithoutArguments handles a start without arguments (a
	// double-click) instead of printing the usage.
	launchWithoutArguments func(inv *invocation) int
	// trayCommand runs `up --tray`, the program started at sign-in.
	trayCommand func(inv *invocation) int
)

// isTrayArgs reports the arguments of the tray: `up --tray`.
func isTrayArgs(args []string) bool {
	return len(args) == 2 && args[0] == "up" && args[1] == "--tray"
}

func register(c command) {
	if _, exists := commands[c.name]; exists {
		panic("aiqsa-connect: command registered twice: " + c.name)
	}
	commands[c.name] = c
}

func main() {
	if platformInit != nil {
		platformInit(os.Args[1:])
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(&invocation{ctx: ctx, args: os.Args[1:], stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr})
	stop()
	os.Exit(code)
}

func run(inv *invocation) int {
	if len(inv.args) == 0 {
		if launchWithoutArguments != nil {
			return launchWithoutArguments(inv)
		}
		printUsage(inv.stderr)
		return 2
	}
	if trayCommand != nil && isTrayArgs(inv.args) {
		return trayCommand(inv)
	}
	switch inv.args[0] {
	case "help", "-h", "--help":
		printUsage(inv.stdout)
		return 0
	}
	c, ok := commands[inv.args[0]]
	if !ok {
		fmt.Fprintf(inv.stderr, "aiqsa-connect: unknown command %q\n\n", inv.args[0])
		printUsage(inv.stderr)
		return 2
	}
	return c.run(&invocation{ctx: inv.ctx, args: inv.args[1:], stdin: inv.stdin, stdout: inv.stdout, stderr: inv.stderr})
}

func printUsage(w io.Writer) {
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Fprintln(w, "Usage: aiqsa-connect <command> [arguments]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	for _, name := range names {
		c := commands[name]
		fmt.Fprintf(w, "  %-32s %s\n", c.usage, c.summary)
	}
}
