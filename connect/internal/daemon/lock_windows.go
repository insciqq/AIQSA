//go:build windows

package daemon

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

type lockFileExLocker struct{}

var systemLocker fileLocker = lockFileExLocker{}

// tryLock locks the file's first byte exclusively without waiting.
func (lockFileExLocker) tryLock(f *os.File) (bool, error) {
	var overlapped windows.Overlapped
	err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return true, nil
	}
	return false, err
}

func (lockFileExLocker) unlock(f *os.File) {
	var overlapped windows.Overlapped
	windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
}
