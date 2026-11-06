package daemon

import (
	"errors"
	"os"
)

// ErrAlreadyRunning means another `up` holds the state directory's lock.
var ErrAlreadyRunning = errors.New("another aiqsa-connect up is already running for this computer")

// fileLocker takes and drops an exclusive lock on an open file without
// waiting: flock on macOS and Linux, LockFileEx on Windows.
type fileLocker interface {
	// tryLock returns busy when another process holds the lock.
	tryLock(f *os.File) (busy bool, err error)
	unlock(f *os.File)
}

// AcquireLock takes an exclusive, non-blocking lock on path. The lock is
// released by the returned function or when the process exits.
func AcquireLock(path string) (release func(), err error) {
	return acquireLock(systemLocker, path)
}

func acquireLock(locker fileLocker, path string) (release func(), err error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	busy, err := locker.tryLock(f)
	if err != nil || busy {
		f.Close()
		if busy {
			return nil, ErrAlreadyRunning
		}
		return nil, err
	}
	return func() {
		locker.unlock(f)
		f.Close()
	}, nil
}
