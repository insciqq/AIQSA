//go:build linux

package monoclock

import (
	"syscall"
	"unsafe"
)

// clockMonotonic is CLOCK_MONOTONIC in <linux/time.h>.
const clockMonotonic = 1

// monotonic reads CLOCK_MONOTONIC with one system call: Go's own monotonic
// readings count from its process's start, so they order nothing between
// processes.
func monotonic() (int64, bool) {
	var ts syscall.Timespec
	if _, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, clockMonotonic, uintptr(unsafe.Pointer(&ts)), 0); errno != 0 {
		return 0, false
	}
	return ts.Nano(), true
}
