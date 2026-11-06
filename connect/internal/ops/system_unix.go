//go:build !windows

package ops

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

type nativeSystem struct{}

// Native is the system the client runs on.
func Native() System { return nativeSystem{} }

func (nativeSystem) GOOS() string { return runtime.GOOS }

// DetectShell is the user's login shell: $SHELL, else the account's shell,
// else /bin/sh.
func (nativeSystem) DetectShell() Shell {
	path := loginShell()
	return Shell{Kind: protocol.ShellPOSIX, Name: filepath.Base(path), Path: path}
}

// ShellCommand runs command in a login shell (`-l -c`), so PATH is the one
// of the user's terminal.
func (nativeSystem) ShellCommand(sh Shell, command, _ string) (*exec.Cmd, func(), error) {
	return exec.Command(sh.Path, "-l", "-c", command), func() {}, nil
}

// Start starts cmd in a process group of its own.
func (nativeSystem) Start(cmd *exec.Cmd) (ProcessTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return groupTree(cmd.Process.Pid), nil
}

func (nativeSystem) OutputFallback(data []byte) string { return replacementFallback(data) }

func (nativeSystem) TextCodePage() CodePage { return nil }

func (nativeSystem) Hidden(fs.FileInfo) bool { return false }

func (nativeSystem) OSVersion() string { return osVersion() }

// groupTree is a process group; its id is the pid of its first process.
type groupTree int

func (g groupTree) Terminate() { syscall.Kill(-int(g), syscall.SIGTERM) }
func (g groupTree) Kill()      { syscall.Kill(-int(g), syscall.SIGKILL) }
func (g groupTree) Release()   {}

func isNotDirError(err error) bool { return errors.Is(err, syscall.ENOTDIR) }
func isIsDirError(err error) bool  { return errors.Is(err, syscall.EISDIR) }

func loginShell() string {
	if shell := os.Getenv("SHELL"); usableShell(shell) {
		return shell
	}
	if shell := passwdShell(); usableShell(shell) {
		return shell
	}
	return "/bin/sh"
}

func usableShell(shell string) bool {
	if shell == "" || !filepath.IsAbs(shell) {
		return false
	}
	info, err := os.Stat(shell)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

// passwdShell asks the account database for the user's shell.
func passwdShell() string {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		out, err := exec.CommandContext(ctx, "dscl", ".", "-read", "/Users/"+u.Username, "UserShell").Output()
		if err != nil {
			return ""
		}
		_, shell, found := strings.Cut(strings.TrimSpace(string(out)), ":")
		if !found {
			return ""
		}
		return strings.TrimSpace(shell)
	}
	out, err := exec.CommandContext(ctx, "getent", "passwd", u.Username).Output()
	if err != nil {
		return ""
	}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	if scanner.Scan() {
		if fields := strings.Split(scanner.Text(), ":"); len(fields) >= 7 {
			return strings.TrimSpace(fields[6])
		}
	}
	return ""
}

// osVersion is the distribution's name on Linux (PRETTY_NAME of
// /etc/os-release) and "macOS <version>" on macOS.
func osVersion() string {
	if runtime.GOOS == "darwin" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "sw_vers", "-productVersion").Output()
		if version := strings.TrimSpace(string(out)); err == nil && version != "" {
			return "macOS " + version
		}
		return "macOS"
	}
	for _, file := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		if name := prettyName(file); name != "" {
			return name
		}
	}
	if release, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		return "Linux " + strings.TrimSpace(string(release))
	}
	return "Linux"
}

func prettyName(file string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
			return strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	return ""
}
