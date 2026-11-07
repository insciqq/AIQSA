package ops

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// errWriteInPlace is what System.PrepareReplacement and System.Replace
// answer when a replacement file could not keep everything attached to
// the file it replaces (owner, ACL, extended attributes) or the volume
// cannot replace files: the file is then written in place, which keeps all
// of it.
var errWriteInPlace = errors.New("the file is written in place")

// replaceFile replaces the file at path, described by info, with data
// atomically: the data goes to a temporary file in the same folder, which
// takes what is attached to the file (System.PrepareReplacement) and is
// moved over it (System.Replace), so a full disk or a crash leaves the old
// file whole. A symbolic link is followed, so the file it points to is
// replaced, not the link. In a folder the user cannot create files in, or
// when the replacement cannot keep what is attached to the file, the file
// is written in place.
func replaceFile(sys System, path string, data []byte, info fs.FileInfo) error {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	inPlace := func() error { return os.WriteFile(path, data, info.Mode().Perm()) }
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".aiqsa-*")
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return inPlace()
		}
		return err
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(tmpName)
		if errors.Is(err, errWriteInPlace) {
			return inPlace()
		}
		return err
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
		return err
	}
	if err := sys.Replace(tmpName, path); err != nil {
		os.Remove(tmpName)
		if errors.Is(err, errWriteInPlace) {
			return inPlace()
		}
		return err
	}
	return nil
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
}

// errXattrsUnsupported is what xattrStore.List answers on a file system
// without extended attributes.
var errXattrsUnsupported = errors.New("extended attributes are not supported")

// copyXattrs gives the replacement file to every extended attribute of the
// file from, POSIX ACLs (system.posix_acl_access) included. On a file
// system without extended attributes there is nothing to copy. When an
// attribute cannot be read or copied (permission, an attribute the file
// system refuses), it answers errWriteInPlace, so nothing attached to the
// file is lost. An attribute the replacement already has with the same
// value (an inherited SELinux label) is not written again.
func copyXattrs(store xattrStore, from, to string) error {
	names, err := store.List(from)
	if errors.Is(err, errXattrsUnsupported) {
		return nil
	}
	if err != nil {
		return errWriteInPlace
	}
	for _, name := range names {
		value, found, err := store.Get(from, name)
		if err != nil {
			return errWriteInPlace
		}
		if !found {
			continue
		}
		if current, found, err := store.Get(to, name); err == nil && found && bytes.Equal(current, value) {
			continue
		}
		if err := store.Set(to, name, value); err != nil {
			return errWriteInPlace
		}
	}
	return nil
}
