//go:build !windows

package main

import "syscall"

// restartProcess replaces this process with the updated binary; it returns
// only when that fails.
func restartProcess(path string, argv, env []string) error {
	return syscall.Exec(path, argv, env)
}
