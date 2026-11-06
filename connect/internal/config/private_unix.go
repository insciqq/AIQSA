//go:build !windows

package config

import (
	"os"
	"syscall"
)

// openNoFollow opens path for reading and refuses a symbolic link.
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// checkPrivateFile refuses a file of another user or one that group or
// others can access.
func checkPrivateFile(_ *os.File, info os.FileInfo, path string) error {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return errOtherOwner(path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return &InsecureCredentialsError{Path: path, Mode: info.Mode()}
	}
	return nil
}

// tightenDir makes a directory the client created private (0700), also one
// created earlier under a permissive umask.
func tightenDir(dir string) error { return os.Chmod(dir, 0o700) }

// syncDir makes a rename in dir durable.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}
