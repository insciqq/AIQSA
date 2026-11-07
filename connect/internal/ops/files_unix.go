//go:build !windows

package ops

import (
	"io/fs"
	"os"
	"slices"
	"syscall"
)

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

// hasFileCapabilities reports whether the file at path carries Linux file
// capabilities (security.capability), which a write removes.
func hasFileCapabilities(path string) bool {
	_, ok, err := unixXattrs{}.Get(path, "security.capability")
	return err == nil && ok
}
