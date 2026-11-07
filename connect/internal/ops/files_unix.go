//go:build !windows

package ops

import (
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"slices"
	"strings"
	"syscall"
)

// fileID names the file at path by its device and inode, which every name
// of it shares; false when it does not exist or cannot be examined.
func fileID(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	return statID(info)
}

// openFileID is fileID of an open file.
func openFileID(f *os.File) (string, bool) {
	info, err := f.Stat()
	if err != nil {
		return "", false
	}
	return statID(info)
}

func statID(info fs.FileInfo) (string, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("id:%d:%d", uint64(st.Dev), uint64(st.Ino)), true
}

// foldPath is how a path keys a lock: on macOS, whose volumes usually
// ignore case, in lower case; elsewhere as it is.
func foldPath(path string) string {
	if runtime.GOOS == "darwin" {
		return strings.ToLower(path)
	}
	return path
}

// canKeepSpecialBits reports whether the process can put back the setuid,
// setgid and sticky bits of the file info describes once a write cleared
// them: root can, and so can the file's owner, for setgid only while the
// file's group is one of the process's (chmod drops setgid silently for
// another group).
func canKeepSpecialBits(info fs.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	euid := os.Geteuid()
	switch {
	case euid == 0:
		return true
	case int(st.Uid) != euid:
		return false
	case info.Mode()&fs.ModeSetgid == 0 || int(st.Gid) == os.Getegid():
		return true
	}
	groups, err := os.Getgroups()
	return err == nil && slices.Contains(groups, int(st.Gid))
}
