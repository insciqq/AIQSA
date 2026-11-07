package ops

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"slices"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// errWriteInPlace is what System.PrepareReplacement and System.Replace
// answer when a replacement file could not keep everything attached to
// the file it replaces (owner, ACL, extended attributes) or the volume
// cannot replace files: the file is then written in place (writeInPlace),
// which keeps all of it.
var errWriteInPlace = errors.New("the file is written in place")

// replaceFile replaces the file at path, described by info, with data
// atomically: the data goes to a temporary file in the same folder, which
// takes what is attached to the file (System.PrepareReplacement) and is
// moved over it (System.Replace), so a full disk or a crash leaves the old
// file whole. A symbolic link is followed, so the file it points to is
// replaced, not the link. On macOS (System.WritesInPlace), in a folder the
// user cannot create files in, or when the replacement cannot keep what is
// attached to the file, the file is written in place (writeInPlace, through
// files). The caller holds the file's locks (lockFile).
//
// Every error is an *unchangedError when the file is as it was, or a
// *notRestoredError or *modeChangedError when it may not be; replaceCode
// maps them.
func replaceFile(sys System, files inPlaceFiles, path string, data []byte, info fs.FileInfo) error {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	inPlace := func() error { return writeInPlace(files, path, data) }
	if sys.WritesInPlace() {
		return inPlace()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".aiqsa-*")
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return inPlace()
		}
		return &unchangedError{err: err}
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(tmpName)
		if errors.Is(err, errWriteInPlace) {
			return inPlace()
		}
		return &unchangedError{err: err}
	}
	if err := sys.PrepareReplacement(tmp, path, info); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return &unchangedError{err: err}
	}
	if err := sys.Replace(tmpName, path); err != nil {
		os.Remove(tmpName)
		var moved *notRestoredError
		switch {
		case errors.Is(err, errWriteInPlace):
			return inPlace()
		case errors.As(err, &moved):
			return err
		}
		// A rename that failed moved nothing.
		return &unchangedError{err: err}
	}
	return nil
}

// unchangedError is a write that failed and left the file as it was: it
// was refused before anything changed, or the file was put back from its
// backup (restored).
type unchangedError struct {
	err      error
	restored bool
}

func (e *unchangedError) Error() string {
	if e.restored {
		return fmt.Sprintf("writing the file failed and its original content was put back, so the original is unchanged: %v", e.err)
	}
	return fmt.Sprintf("the file was not changed: %v", e.err)
}

func (e *unchangedError) Unwrap() error { return e.err }

// notRestoredError is a write that failed and may have left the file
// damaged: putting its original content back failed too, and the original
// is kept whole at backup. It has no Unwrap, so no code that says the file
// is unchanged can come from its causes.
type notRestoredError struct {
	err, restoreErr error
	backup          string
}

func (e *notRestoredError) Error() string {
	return fmt.Sprintf("writing the file failed (%v) and putting its original content back failed too (%v); the original is kept at %s",
		e.err, e.restoreErr, e.backup)
}

// modeChangedError is a write in place after which the file's mode bits
// could not be put back (keepMode): the kernel cleared its setuid or setgid
// bit on the write, and chmod failed or did not hold. The file has the new
// content (err is nil) or its original one (err is the write's
// *unchangedError). It has no Unwrap, so its code is connect_device_error:
// the file changed.
type modeChangedError struct {
	err, modeErr error
}

func (e *modeChangedError) Error() string {
	if e.err == nil {
		return fmt.Sprintf("the file was written, but its mode could not be put back: %v", e.modeErr)
	}
	return fmt.Sprintf("%v, but its mode could not be put back: %v", e.err, e.modeErr)
}

// errModeNotKept refuses to write in place a file with setuid, setgid or
// sticky bits the process could not put back once the write cleared them
// (canKeepSpecialBits).
var errModeNotKept = fmt.Errorf("the file's setuid, setgid or sticky bit could not be kept: %w", fs.ErrPermission)

// replaceCode is the reply code of a replaceFile error. A failure that
// left the file as it was is definite, so the server reports it as not
// done: computer_permission_denied, computer_file_too_large for a full
// disk, a quota or a file size limit, and what codeOf knows. Any other
// cause, and every failure that may have changed the file, is
// connect_device_error, whose outcome the server keeps unknown.
func replaceCode(err error) protocol.ReasonCode {
	var unchanged *unchangedError
	if !errors.As(err, &unchanged) {
		return protocol.CodeDeviceError
	}
	switch {
	case errors.Is(err, fs.ErrPermission):
		return protocol.CodeComputerPermissionDenied
	case isNoSpaceError(err):
		return protocol.CodeComputerFileTooLarge
	}
	return codeOf(err)
}

// inPlaceFiles is what writeInPlace needs from the file system: osFiles,
// or a fake in tests.
type inPlaceFiles interface {
	// Open opens an existing file for reading and writing; it never
	// creates or truncates one.
	Open(path string) (inPlaceFile, error)
	// CreateBackup creates a new file only the user can read, outside the
	// folder of the file it backs up: in the system's temporary folder.
	CreateBackup() (inPlaceFile, error)
	Remove(name string) error
}

// inPlaceFile is an open file (*os.File).
type inPlaceFile interface {
	io.ReaderAt
	io.WriterAt
	Name() string
	Stat() (fs.FileInfo, error)
	Chmod(mode fs.FileMode) error
	Truncate(size int64) error
	Sync() error
	Close() error
}

type osFiles struct{}

func (osFiles) Open(path string) (inPlaceFile, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (osFiles) CreateBackup() (inPlaceFile, error) {
	f, err := os.CreateTemp("", "aiqsa-connect-original-*")
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (osFiles) Remove(name string) error { return os.Remove(name) }

// writeInPlace writes data into the existing file at path itself, which
// keeps everything attached to it: owner, ACLs (POSIX and macOS),
// extended attributes, streams and hard links. The file's bytes are first
// copied to a backup outside its folder, made durable; without one nothing
// is written. The data then overwrites the file from its start and the
// file is cut to its length, never emptied first. On a failure the bytes
// that may have changed are put back from the backup. When that fails too,
// the backup is kept and the error names it; otherwise it is removed.
//
// The kernel clears a file's setuid and setgid bits when it is written, so
// the mode bits are put back after the write and after a restore, and
// checked (keepMode). A file with setuid, setgid or sticky bits the process
// could not put back (canKeepSpecialBits) is refused before anything
// changes.
func writeInPlace(files inPlaceFiles, path string, data []byte) error {
	f, err := files.Open(path)
	if err != nil {
		return &unchangedError{err: err}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return &unchangedError{err: err}
	}
	mode := info.Mode() & keptModeBits
	if mode&specialModeBits != 0 && !canKeepSpecialBits(info) {
		return &unchangedError{err: errModeNotKept}
	}
	backup, size, err := backUp(files, f)
	if err != nil {
		return &unchangedError{err: err}
	}
	changed, err := overwrite(f, data)
	if err != nil {
		if restoreErr := restore(f, backup, size, changed); restoreErr != nil {
			keepMode(f, mode)
			backup.Close()
			return &notRestoredError{err: err, restoreErr: restoreErr, backup: backup.Name()}
		}
		err = &unchangedError{err: err, restored: true}
	}
	if modeErr := keepMode(f, mode); modeErr != nil {
		err = &modeChangedError{err: err, modeErr: modeErr}
	}
	backup.Close()
	files.Remove(backup.Name())
	return err
}

// keepMode gives f the mode bits mode again when a write changed them, and
// checks that they hold: chmod can drop setgid without an error.
func keepMode(f inPlaceFile, mode fs.FileMode) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Mode()&keptModeBits == mode {
		return nil
	}
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if info, err = f.Stat(); err != nil {
		return err
	}
	if got := info.Mode() & keptModeBits; got != mode {
		return fmt.Errorf("the mode is %v instead of %v", got, mode)
	}
	return nil
}

// backUp copies the open file f to a new backup file and makes the copy
// durable. size is f's length.
func backUp(files inPlaceFiles, f inPlaceFile) (backup inPlaceFile, size int64, err error) {
	backup, err = files.CreateBackup()
	if err != nil {
		return nil, 0, err
	}
	size, err = io.Copy(io.NewOffsetWriter(backup, 0), io.NewSectionReader(f, 0, math.MaxInt64))
	if err == nil {
		err = backup.Sync()
	}
	if err != nil {
		backup.Close()
		files.Remove(backup.Name())
		return nil, 0, err
	}
	return backup, size, nil
}

// overwrite writes data over f from its start, cuts f to its length and
// makes it durable. On a failure, changed is how far from its start f may
// differ from what it was: the data's length while only writing (the count
// WriteAt returns leaves out bytes a later failure followed), all of it
// once f was cut.
func overwrite(f inPlaceFile, data []byte) (changed int64, err error) {
	if _, err := f.WriteAt(data, 0); err != nil {
		return int64(len(data)), err
	}
	if err := f.Truncate(int64(len(data))); err != nil {
		return math.MaxInt64, err
	}
	if err := f.Sync(); err != nil {
		return math.MaxInt64, err
	}
	return 0, nil
}

// restore puts the first changed bytes of f back from backup, cuts f to
// its former size and makes it durable. Bytes past changed were not
// touched and are not written again.
func restore(f, backup inPlaceFile, size, changed int64) error {
	end := min(size, changed)
	copied, err := io.Copy(io.NewOffsetWriter(f, 0), io.NewSectionReader(backup, 0, end))
	if err != nil {
		return err
	}
	if copied != end {
		return io.ErrUnexpectedEOF
	}
	if err := f.Truncate(size); err != nil {
		return err
	}
	return f.Sync()
}

// xattrStore reads and writes the extended attributes of files by path
// (x/sys/unix on macOS and Linux; a fake in tests).
type xattrStore interface {
	// List names the attributes of the file; errXattrsUnsupported when its
	// file system has none.
	List(path string) ([]string, error)
	// Get returns an attribute's value; found is false when the file has no
	// such attribute (any more).
	Get(path, name string) (value []byte, found bool, err error)
	Set(path, name string, value []byte) error
	// Remove removes an attribute; one the file does not have is no error.
	Remove(path, name string) error
}

// errXattrsUnsupported is what xattrStore.List answers on a file system
// without extended attributes.
var errXattrsUnsupported = errors.New("extended attributes are not supported")

// posixACLAccess is the extended attribute that holds a file's POSIX
// access ACL on Linux.
const posixACLAccess = "system.posix_acl_access"

// copyXattrs gives the replacement file to every extended attribute of the
// file from, POSIX ACLs (system.posix_acl_access) included. On a file
// system without extended attributes there is nothing to copy. When an
// attribute cannot be read or copied (permission, an attribute the file
// system refuses), it answers errWriteInPlace, so nothing attached to the
// file is lost. An attribute the replacement already has with the same
// value (an inherited SELinux label) is not written again.
//
// A replacement created in a folder with a default ACL inherits an access
// ACL; when the file has none, it is removed, or the mode set afterwards
// would become that ACL's mask instead of the group's permissions, and
// the ACL's named users and groups would keep access the file never gave
// them. It answers errWriteInPlace when it cannot be removed.
func copyXattrs(store xattrStore, from, to string) error {
	names, err := store.List(from)
	if errors.Is(err, errXattrsUnsupported) {
		return nil
	}
	if err != nil {
		return errWriteInPlace
	}
	copied := map[string]bool{}
	for _, name := range names {
		value, found, err := store.Get(from, name)
		if err != nil {
			return errWriteInPlace
		}
		if !found {
			continue
		}
		copied[name] = true
		if current, found, err := store.Get(to, name); err == nil && found && bytes.Equal(current, value) {
			continue
		}
		if err := store.Set(to, name, value); err != nil {
			return errWriteInPlace
		}
	}
	if copied[posixACLAccess] {
		return nil
	}
	inherited, err := store.List(to)
	if errors.Is(err, errXattrsUnsupported) {
		return nil
	}
	if err != nil {
		return errWriteInPlace
	}
	if slices.Contains(inherited, posixACLAccess) {
		if err := store.Remove(to, posixACLAccess); err != nil {
			return errWriteInPlace
		}
	}
	return nil
}
