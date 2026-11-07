package ops

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// fileLocks serializes the writes and edits of each file, which the
// executor runs side by side for any chat of its user: two writes in place
// of one file that interleave their writes and cuts would both succeed and
// leave neither content. A lock is a key's, made when an op first waits
// for it and dropped when no op holds or waits for it any more.
type fileLocks struct {
	mu    sync.Mutex
	locks map[string]*fileLock
}

type fileLock struct {
	// token holds a value while the lock is held.
	token chan struct{}
	// users counts the ops holding and waiting for it.
	users int
}

// lock takes key's lock, waiting while another op holds it; it stops
// waiting when ctx ends (the op was cancelled or reached its deadline) and
// answers that error. unlock releases the lock.
func (l *fileLocks) lock(ctx context.Context, key string) (unlock func(), err error) {
	l.mu.Lock()
	if l.locks == nil {
		l.locks = map[string]*fileLock{}
	}
	entry := l.locks[key]
	if entry == nil {
		entry = &fileLock{token: make(chan struct{}, 1)}
		l.locks[key] = entry
	}
	entry.users++
	l.mu.Unlock()
	select {
	case entry.token <- struct{}{}:
		return func() {
			<-entry.token
			l.leave(key, entry)
		}, nil
	case <-ctx.Done():
		l.leave(key, entry)
		return nil, ctx.Err()
	}
}

func (l *fileLocks) leave(key string, entry *fileLock) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry.users--
	if entry.users == 0 {
		delete(l.locks, key)
	}
}

// heldFile is a file a write or edit holds the locks of: its path's, so
// two ops on one name wait for each other also while the file does not
// exist yet, and, when it exists, its identity's (fileID), so the file's
// other names (a hard link, another case of its name) wait too. Every op
// takes the path's lock first and at most one identity's, so no two ops
// wait for each other.
type heldFile struct {
	locks *fileLocks
	// path is the file, its symbolic links resolved (realPath): where the
	// op reads and writes.
	path       string
	pathUnlock func()
	idUnlock   func()
}

// lockFile takes the locks of the file at target for a write or edit,
// waiting at most until ctx ends: then it answers computer_timeout or
// computer_cancelled, and nothing was read or changed.
func (e *Executor) lockFile(ctx context.Context, target string) (*heldFile, protocol.ReasonCode) {
	path := realPath(target)
	unlock, err := e.fileLocks.lock(ctx, "path:"+foldPath(filepath.Clean(path)))
	if err != nil {
		return nil, ctxCode(ctx)
	}
	held := &heldFile{locks: &e.fileLocks, path: path, pathUnlock: unlock}
	if err := held.lockExisting(ctx); err != nil {
		held.release()
		return nil, ctxCode(ctx)
	}
	return held, ""
}

// lockExisting takes the identity lock of the file now at h.path, in place
// of one it held: none when no file is there. Another name of the file may
// replace it while this op waits, so the identity is read again once the
// lock is held, and the lock of a replaced file is let go.
func (h *heldFile) lockExisting(ctx context.Context) error {
	if h.idUnlock != nil {
		h.idUnlock()
		h.idUnlock = nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		id, ok := fileID(h.path)
		if !ok {
			// No file, or one that cannot be opened: the path's lock holds it.
			return nil
		}
		unlock, err := h.locks.lock(ctx, id)
		if err != nil {
			return err
		}
		if again, ok := fileID(h.path); ok && again == id {
			h.idUnlock = unlock
			return nil
		}
		unlock()
	}
}

// lockCreated takes the identity lock of the file f this op has just
// created, which another name of it may already have reached.
func (h *heldFile) lockCreated(ctx context.Context, f *os.File) error {
	id, ok := openFileID(f)
	if !ok {
		return nil
	}
	unlock, err := h.locks.lock(ctx, id)
	if err != nil {
		return err
	}
	h.idUnlock = unlock
	return nil
}

func (h *heldFile) release() {
	if h.idUnlock != nil {
		h.idUnlock()
		h.idUnlock = nil
	}
	h.pathUnlock()
}

// maxLinkHops bounds how many symbolic links realPath follows.
const maxLinkHops = 40

// realPath is path with its symbolic links resolved. A file that does not
// exist yet is where it would be created: the target of a dangling link,
// in its folder with that folder's links resolved; path as given when not
// even its folder exists.
func realPath(path string) string {
	path = filepath.Clean(path)
	for range maxLinkHops {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return resolved
		}
		link, err := os.Readlink(path)
		if err != nil {
			break
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(realDir(filepath.Dir(path)), link)
		}
		path = filepath.Clean(link)
	}
	return filepath.Join(realDir(filepath.Dir(path)), filepath.Base(path))
}

func realDir(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return dir
}

// ctxCode is the reply code of an op whose context ended: computer_timeout
// at its deadline, otherwise computer_cancelled.
func ctxCode(ctx context.Context) protocol.ReasonCode {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return protocol.CodeComputerTimeout
	}
	return protocol.CodeComputerCancelled
}

// specialModeBits are the mode bits a write can clear: the kernel drops
// setuid and setgid when a file is written, and the process puts them back.
const specialModeBits = fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky

// keptModeBits are the mode bits a write in place keeps.
const keptModeBits = fs.ModePerm | specialModeBits
