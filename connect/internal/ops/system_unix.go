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

	"golang.org/x/sys/unix"

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

// WritesInPlace is true on macOS: its extended ACLs (chmod +a) are not
// extended attributes, so only writing the file itself keeps them.
func (nativeSystem) WritesInPlace() bool { return runtime.GOOS == "darwin" }

// PrepareReplacement gives tmp the owner and group, extended attributes
// and mode bits of the file it replaces, and drops an access ACL tmp
// inherited from its folder that the file lacks (copyXattrs). A user who
// may not give the file its owner or group, or an attribute, gets the file
// written in place. The mode comes last: chown clears setuid and setgid,
// and the ACL's mask is the group bits of the mode.
func (nativeSystem) PrepareReplacement(tmp *os.File, path string, info fs.FileInfo) error {
	if want, ok := info.Sys().(*syscall.Stat_t); ok {
		current, err := tmp.Stat()
		if err != nil {
			return err
		}
		if have, ok := current.Sys().(*syscall.Stat_t); ok && (have.Uid != want.Uid || have.Gid != want.Gid) {
			uid, gid := -1, -1
			if have.Uid != want.Uid {
				uid = int(want.Uid)
			}
			if have.Gid != want.Gid {
				gid = int(want.Gid)
			}
			if err := tmp.Chown(uid, gid); err != nil {
				return errWriteInPlace
			}
		}
	}
	if err := copyXattrs(unixXattrs{}, path, tmp.Name()); err != nil {
		return err
	}
	return tmp.Chmod(info.Mode() & (fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky))
}

// Replace renames tmp over path.
func (nativeSystem) Replace(tmp, path string) error { return os.Rename(tmp, path) }

// unixXattrs reads and writes extended attributes through x/sys/unix,
// following symbolic links (the paths are resolved already).
type unixXattrs struct{}

func (unixXattrs) List(path string) ([]string, error) {
	buf, err := xattrRead(func(dest []byte) (int, error) { return unix.Listxattr(path, dest) })
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
		return nil, errXattrsUnsupported
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, name := range strings.Split(string(buf), "\x00") {
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}

func (unixXattrs) Get(path, name string) ([]byte, bool, error) {
	value, err := xattrRead(func(dest []byte) (int, error) { return unix.Getxattr(path, name, dest) })
	if errors.Is(err, errNoXattr) {
		return nil, false, nil
	}
	return value, err == nil, err
}

func (unixXattrs) Set(path, name string, value []byte) error {
	return unix.Setxattr(path, name, value, 0)
}

func (unixXattrs) Remove(path, name string) error {
	if err := unix.Removexattr(path, name); err != nil && !errors.Is(err, errNoXattr) {
		return err
	}
	return nil
}

// xattrRead asks read for the size, then for the bytes, again when they
// grew in between.
func xattrRead(read func(dest []byte) (int, error)) ([]byte, error) {
	for range 3 {
		size, err := read(nil)
		if err != nil {
			return nil, err
		}
		if size == 0 {
			return []byte{}, nil
		}
		buf := make([]byte, size)
		n, err := read(buf)
		if errors.Is(err, unix.ERANGE) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return buf[:n], nil
	}
	return nil, unix.ERANGE
}

func isNotDirError(err error) bool { return errors.Is(err, syscall.ENOTDIR) }
func isIsDirError(err error) bool  { return errors.Is(err, syscall.EISDIR) }

// isNoSpaceError is a full disk, a disk quota or the file size limit
// (RLIMIT_FSIZE).
func isNoSpaceError(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) || errors.Is(err, syscall.EFBIG)
}

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
