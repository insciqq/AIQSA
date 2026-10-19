package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/hooks"
	"github.com/insciqq/AIQSA/connect/internal/status"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "setup",
		usage:   "setup [--remove] [--yes]",
		summary: "Check tmux and add (or remove) the agent status hooks",
		run:     runSetup,
	})
}

// Replaced by tests: nothing in a test may look up or touch the real agents.
var (
	setupCheckTmux = func() error {
		bin, err := tmux.FindBinary()
		if err != nil {
			return err
		}
		return tmux.CheckVersion(bin)
	}
	setupFindAgent  = findAgentInLoginShell
	setupExecutable = selfExecutable
)

// agentLookupTimeout bounds the login shell that resolves an agent's path.
const agentLookupTimeout = 10 * time.Second

// findAgentInLoginShell asks the user's login shell where the agent's
// command is (`command -v`), so a PATH set in shell profiles counts. It only
// resolves the name; the agent itself is never run. A name that resolves to
// an alias or a function counts as found without a path.
func findAgentInLoginShell(ctx context.Context, name string) (path string, found bool) {
	ctx, cancel := context.WithTimeout(ctx, agentLookupTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, tmux.LoginShell(), "-lic", "command -v "+name)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if last == "" {
		return "", false
	}
	if filepath.IsAbs(last) {
		return last, true
	}
	return "", true
}

var setupAgents = []struct {
	agent status.Agent
	name  string
}{
	{status.AgentClaude, "Claude Code"},
	{status.AgentCodex, "Codex"},
}

func runSetup(inv *invocation) int {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(inv.stderr)
	remove := flags.Bool("remove", false, "remove the hooks this client added")
	yes := flags.Bool("yes", false, "do not ask before changing the agents' settings files")
	if err := flags.Parse(inv.args); err != nil || flags.NArg() > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect setup [--remove] [--yes]")
		return 2
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
	if *remove {
		return setupRemove(inv, home, *yes)
	}
	return setupInstall(inv, home, *yes)
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

func setupInstall(inv *invocation, home string, yes bool) int {
	if err := setupCheckTmux(); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect setup: %v\n", err)
		return 1
	}
	fmt.Fprintln(inv.stdout, "tmux: ok")
	executable := setupExecutable()
	if executable == "" || !filepath.IsAbs(executable) {
		fmt.Fprintln(inv.stderr, "aiqsa-connect setup: cannot determine where this aiqsa-connect executable is")
		return 1
	}
	var plans []*hooks.Plan
	installed := map[status.Agent]bool{}
	for _, a := range setupAgents {
		path, found := setupFindAgent(inv.ctx, string(a.agent))
		if !found {
			fmt.Fprintf(inv.stdout, "%s: not found (run aiqsa-connect setup again after installing it)\n", a.name)
			continue
		}
		if path != "" {
			fmt.Fprintf(inv.stdout, "%s: %s\n", a.name, path)
		} else {
			fmt.Fprintf(inv.stdout, "%s: found\n", a.name)
		}
		plan, err := hooks.PlanInstall(hooks.DefaultFile(home, a.agent), executable, a.agent)
		if err != nil {
			fmt.Fprintf(inv.stderr, "aiqsa-connect setup: %v\n", err)
			return 1
		}
		installed[a.agent] = true
		plans = append(plans, plan)
	}
	if len(plans) == 0 {
		fmt.Fprintln(inv.stdout, "Neither Claude Code nor Codex was found, so no hooks were added. Sessions still work; their status is not reported.")
		printNextSteps(inv.stdout, installed)
		return 0
	}
	changes := changedPlans(plans)
	if len(changes) == 0 {
		fmt.Fprintln(inv.stdout, "The AIQSA Connect status hooks are already set up.")
		printNextSteps(inv.stdout, installed)
		return 0
	}
	fmt.Fprintln(inv.stdout)
	fmt.Fprintln(inv.stdout, "AIQSA Connect adds hooks that report when an agent is working, needs your approval or waits for you.")
	fmt.Fprintln(inv.stdout, "They only report: they never answer, approve or change anything, and do nothing outside AIQSA Connect sessions.")
	describePlans(inv.stdout, changes, "Will change")
	if !confirm(inv, yes, "Add the hooks?") {
		fmt.Fprintln(inv.stdout, "Nothing was changed.")
		return 1
	}
	if !applyPlans(inv, changes) {
		return 1
	}
	fmt.Fprintln(inv.stdout, "Hooks added.")
	printNextSteps(inv.stdout, installed)
	return 0
}

func setupRemove(inv *invocation, home string, yes bool) int {
	var plans []*hooks.Plan
	for _, a := range setupAgents {
		plan, err := hooks.PlanRemove(hooks.DefaultFile(home, a.agent))
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
		case !p.Exists:
			fmt.Fprintf(w, "  %s (new file)\n", p.Path)
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

func printNextSteps(w io.Writer, installed map[status.Agent]bool) {
	settings := "AIQSA Settings → Connected apps"
	if paths, err := config.ResolvePaths(); err == nil {
		if creds, err := paths.LoadCredentials(); err == nil {
			settings += " (" + creds.Origin + "/?settings=connected_apps)"
		}
	}
	var steps []string
	switch {
	case installed[status.AgentClaude] && installed[status.AgentCodex]:
		steps = append(steps, "Sign in to Claude Code and Codex here, at this computer (claude, then /login; codex login).")
	case installed[status.AgentClaude]:
		steps = append(steps, "Sign in to Claude Code here, at this computer (claude, then /login).")
	case installed[status.AgentCodex]:
		steps = append(steps, "Sign in to Codex here, at this computer (codex login).")
	}
	if installed[status.AgentCodex] {
		steps = append(steps, "Run codex once and trust the AIQSA Connect hook in /hooks: Codex runs a new hook only after you trust it.")
	}
	steps = append(steps,
		"To use AIQSA Memory, Skills and Hub from the agents, connect them in "+settings+" and sign in to MCP there.",
		"Start the client: aiqsa-connect service install (or run aiqsa-connect up).",
	)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Next steps:")
	for i, step := range steps {
		fmt.Fprintf(w, "  %d. %s\n", i+1, step)
	}
}
