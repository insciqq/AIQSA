//go:build !windows

package daemon

import (
	"errors"
	"os"
	"syscall"
)

type flockLocker struct{}

var systemLocker fileLocker = flockLocker{}

func (flockLocker) tryLock(f *os.File) (bool, error) {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return true, nil
	}
	return false, err
}

func (flockLocker) unlock(f *os.File) { syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
