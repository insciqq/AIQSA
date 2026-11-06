package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/hooks"
)

func init() {
	register(command{
		name:    "setup",
		usage:   "setup --remove [--yes]",
		summary: "Remove the Claude Code and Codex hooks an earlier version added",
		run:     runSetup,
	})
}

var setupAgents = []hooks.Agent{hooks.AgentClaude, hooks.AgentCodex}

func runSetup(inv *invocation) int {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(inv.stderr)
	remove := flags.Bool("remove", false, "remove the hooks an earlier version added")
	yes := flags.Bool("yes", false, "do not ask before changing the agents' settings files")
	if err := flags.Parse(inv.args); err != nil || flags.NArg() > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect setup --remove [--yes]")
		return 2
	}
	if !*remove {
		fmt.Fprintln(inv.stdout, "There is nothing to set up: AIQSA Connect needs no hooks. To remove the hooks an earlier version added, run: aiqsa-connect setup --remove")
		return 0
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		fmt.Fprintln(inv.stderr, "aiqsa-connect setup: cannot determine the home directory")
		return 1
	}
	release, err := lockSetup()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect setup: %v\n", err)
		return 1
	}
	defer release()
	return setupRemove(inv, home, *yes)
}

// lockSetup keeps a second setup from editing the same files while the
// first one waits for its answer.
func lockSetup() (release func(), err error) {
	paths, err := config.ResolvePaths()
	if err != nil {
		return nil, err
	}
	if err := paths.EnsureStateDir(); err != nil {
		return nil, err
	}
	release, err = daemon.AcquireLock(filepath.Join(paths.StateDir, "setup.lock"))
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		return nil, errors.New("another aiqsa-connect setup is running; finish it first")
	}
	return release, err
}

func setupRemove(inv *invocation, home string, yes bool) int {
	var plans []*hooks.Plan
	for _, agent := range setupAgents {
		plan, err := hooks.PlanRemove(hooks.DefaultFile(home, agent))
		if err != nil {
			fmt.Fprintf(inv.stderr, "aiqsa-connect setup: %v\n", err)
			return 1
		}
		plans = append(plans, plan)
	}
	changes := changedPlans(plans)
	if len(changes) == 0 {
		fmt.Fprintln(inv.stdout, "No AIQSA Connect hooks are set up.")
		return 0
	}
	describePlans(inv.stdout, changes, "Will remove the AIQSA Connect hooks from")
	if !confirm(inv, yes, "Remove the hooks?") {
		fmt.Fprintln(inv.stdout, "Nothing was changed.")
		return 1
	}
	if !applyPlans(inv, changes) {
		return 1
	}
	fmt.Fprintln(inv.stdout, "Hooks removed. Other hooks and settings were left as they were.")
	return 0
}

func changedPlans(plans []*hooks.Plan) []*hooks.Plan {
	var changed []*hooks.Plan
	for _, p := range plans {
		if p.Changed {
			changed = append(changed, p)
		}
	}
	return changed
}

func describePlans(w io.Writer, plans []*hooks.Plan, verb string) {
	fmt.Fprintf(w, "%s:\n", verb)
	for _, p := range plans {
		switch {
		case p.Delete:
			fmt.Fprintf(w, "  %s (it holds only these hooks, so it is deleted)\n", p.Path)
		default:
			if _, err := os.Lstat(p.Backup()); errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(w, "  %s (a copy is kept at %s)\n", p.Path, p.Backup())
			} else {
				fmt.Fprintf(w, "  %s\n", p.Path)
			}
		}
	}
}

// confirm asks a y/N question on the invocation's streams; anything but
// y or yes, or the end of input, is no.
func confirm(inv *invocation, yes bool, question string) bool {
	if yes {
		return true
	}
	fmt.Fprintf(inv.stdout, "%s [y/N] ", question)
	line, _ := bufio.NewReader(inv.stdin).ReadString('\n')
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}

func applyPlans(inv *invocation, plans []*hooks.Plan) bool {
	for _, p := range plans {
		if err := p.Apply(); err != nil {
			fmt.Fprintf(inv.stderr, "aiqsa-connect setup: cannot write %s: %v\n", p.Path, err)
			return false
		}
	}
	return true
}
