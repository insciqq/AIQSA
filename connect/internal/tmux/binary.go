// Package tmux runs the client's own tmux server (`tmux -L <socket>`):
// its generated config, sessions with metadata in user options, history
// and the answer options of agent permission menus. tmux is always run
// through argument vectors with -u, never through a shell.
package tmux

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ErrNotInstalled and ErrTooOld explain how to get a suitable tmux.
var (
	ErrNotInstalled = errors.New("tmux is not installed; tmux 3.2 or newer is required (brew install tmux / sudo apt install tmux)")
	ErrTooOld       = errors.New("tmux 3.2 or newer is required (brew install tmux / sudo apt install tmux)")
)

// fallbackDirs are searched after PATH: launchd services get a short PATH.
var fallbackDirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}

// FindBinary returns the absolute path of tmux from PATH or the usual
// install directories.
func FindBinary() (string, error) {
	if path, err := exec.LookPath("tmux"); err == nil {
		if abs, err := filepath.Abs(path); err == nil {
			return abs, nil
		}
	}
	for _, dir := range fallbackDirs {
		candidate := filepath.Join(dir, "tmux")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", ErrNotInstalled
}

var versionNumber = regexp.MustCompile(`(\d+)\.(\d+)`)

// ParseVersion reads `tmux -V` output such as "tmux 3.4", "tmux 3.3a" or
// "tmux next-3.5". A development build ("tmux master") counts as new.
func ParseVersion(output string) (major, minor int, err error) {
	output = strings.TrimSpace(output)
	if m := versionNumber.FindStringSubmatch(output); m != nil {
		major, _ = strconv.Atoi(m[1])
		minor, _ = strconv.Atoi(m[2])
		return major, minor, nil
	}
	if strings.Contains(output, "master") {
		return 99, 0, nil
	}
	return 0, 0, fmt.Errorf("unrecognized tmux version %q", output)
}

// CheckVersion runs `tmux -V` and requires 3.2 or newer.
func CheckVersion(bin string) error {
	out, err := exec.Command(bin, "-V").Output()
	if err != nil {
		return fmt.Errorf("cannot run tmux -V: %w", err)
	}
	major, minor, err := ParseVersion(string(out))
	if err != nil {
		return err
	}
	if major < 3 || major == 3 && minor < 2 {
		return ErrTooOld
	}
	return nil
}
