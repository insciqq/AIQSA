package daemon

import (
	"errors"
	"os"
	"syscall"
)

// ErrAlreadyRunning means another `up` holds the state directory's lock.
var ErrAlreadyRunning = errors.New("another aiqsa-connect up is already running for this computer")

// AcquireLock takes an exclusive, non-blocking flock on path. The lock is
// released by the returned function or when the process exits.
func AcquireLock(path string) (release func(), err error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrAlreadyRunning
		}
		return nil, err
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}
