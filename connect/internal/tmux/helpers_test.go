package tmux_test

import (
	"os/exec"

	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func runTmux(bin string, args ...string) error {
	cmd := exec.Command(bin, args...)
	cmd.Env = tmux.Environ()
	return cmd.Run()
}
