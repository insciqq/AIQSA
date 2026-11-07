package ops

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// replaceFile renames the prepared replacement over the file, or writes
// the file in place when the system says the replacement cannot keep what
// is attached to it (always on macOS); any other failure leaves the file
// as it was and answers a definite code when its cause has one.
func TestReplaceFileFallsBackToWritingInPlace(t *testing.T) {
	permission := &fs.PathError{Op: "replace", Path: "x", Err: fs.ErrPermission}
	noSpace := &fs.PathError{Op: "write", Path: "x", Err: syscall.ENOSPC}
	cases := []struct {
		name        string
		inPlace     bool
		prepare     error
		replace     error
		wantCode    protocol.ReasonCode
		wantInPlace bool
		wantPrepare bool
		wantReplace bool
	}{
		{name: "attributes kept", wantPrepare: true, wantReplace: true},
		{name: "attributes cannot be kept", prepare: errWriteInPlace, wantInPlace: true, wantPrepare: true},
		{name: "volume cannot replace", replace: errWriteInPlace, wantInPlace: true, wantPrepare: true, wantReplace: true},
		{name: "macOS", inPlace: true, wantInPlace: true},
		{name: "prepare fails", prepare: errors.New("io"), wantCode: protocol.CodeDeviceError, wantPrepare: true},
		{name: "no space", prepare: noSpace, wantCode: protocol.CodeComputerFileTooLarge, wantPrepare: true},
		{name: "replace fails", replace: permission, wantCode: protocol.CodeComputerPermissionDenied, wantPrepare: true, wantReplace: true},
		{name: "original not put back", replace: &notRestoredError{err: permission, restoreErr: permission, backup: "b"},
			wantCode: protocol.CodeDeviceError, wantPrepare: true, wantReplace: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prepared, replaced := false, false
			e, home := newTestExecutor(t, testSystem{
				inPlace: tc.inPlace,
				prepare: func(*os.File, string, fs.FileInfo) error {
					prepared = true
					return tc.prepare
				},
				replace: func(tmp, path string) error {
					replaced = true
					if tc.replace != nil {
						return tc.replace
					}
					return os.Rename(tmp, path)
				},
			})
			backups := t.TempDir()
			t.Setenv("TMPDIR", backups)
			dir := filepath.Join(home, "dir")
			path := filepath.Join(dir, "notes.txt")
			writeTestFile(t, path, []byte("old\n"))
			held, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Close()
			_, code := run(t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"})
			if code != tc.wantCode {
				t.Fatalf("code %q, want %q", code, tc.wantCode)
			}
			if prepared != tc.wantPrepare || replaced != tc.wantReplace {
				t.Fatalf("prepare called: %v, replace called: %v", prepared, replaced)
			}
			want := "new\n"
			if tc.wantCode != "" {
				want = "old\n"
			}
			if got := readTestFile(t, path); string(got) != want {
				t.Fatalf("content %q, want %q", got, want)
			}
			old, _ := io.ReadAll(held)
			if inPlace := string(old) == "new\n"; inPlace != tc.wantInPlace {
				t.Fatalf("written in place: %v", inPlace)
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 1 {
				t.Fatalf("left files behind: %v", entries)
			}
			if entries, _ := os.ReadDir(backups); len(entries) != 0 {
				t.Fatalf("left backups behind: %v", entries)
			}
		})
	}
}

// Written in place (always on macOS), a file stays the same file: a process
// holding it and a hard link see the new content, shorter or longer, its
// mode stays, and no backup is left.
func TestWriteAndEditInPlaceKeepTheFile(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{inPlace: true})
	backups := t.TempDir()
	t.Setenv("TMPDIR", backups)
	dir := filepath.Join(home, "dir")
	path := filepath.Join(dir, "notes.txt")
	writeTestFile(t, path, []byte("a first line\na second line\n"))
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(home, "hard.txt")
	if err := os.Link(path, link); err != nil {
		t.Skipf("no hard links: %v", err)
	}
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "short\n"})
	if got := readTestFile(t, link); string(got) != "short\n" {
		t.Fatalf("after write: %q", got)
	}
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "short", NewString: "a much longer line than before"})
	const want = "a much longer line than before\n"
	if got := readTestFile(t, link); string(got) != want {
		t.Fatalf("after edit: %q", got)
	}
	if got, _ := io.ReadAll(held); string(got) != want {
		t.Fatalf("the held file: %q", got)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode: %v", info.Mode())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
	if entries, _ := os.ReadDir(backups); len(entries) != 0 {
		t.Fatalf("left backups behind: %v", entries)
	}
}

// faults makes a faultyFile fail: WriteAt past writeLimit (when set) with
// ENOSPC after writing up to it, as a full disk or a file size limit does;
// the first truncateFails calls of Truncate, syncFails of Sync and
// chmodFails of Chmod with EIO. stat, when set, changes what Stat answers.
type faults struct {
	writeLimit    int64
	truncateFails int
	syncFails     int
	chmodFails    int
	stat          func(fs.FileInfo) fs.FileInfo
	writes        int
}

type faultyFile struct {
	*os.File
	*faults
}

func (f faultyFile) WriteAt(p []byte, off int64) (int, error) {
	f.writes++
	if f.writeLimit > 0 && off+int64(len(p)) > f.writeLimit {
		n, _ := f.File.WriteAt(p[:max(0, f.writeLimit-off)], off)
		return n, &fs.PathError{Op: "write", Path: f.Name(), Err: syscall.ENOSPC}
	}
	return f.File.WriteAt(p, off)
}

func (f faultyFile) Truncate(size int64) error {
	if f.truncateFails > 0 {
		f.truncateFails--
		return &fs.PathError{Op: "truncate", Path: f.Name(), Err: syscall.EIO}
	}
	return f.File.Truncate(size)
}

func (f faultyFile) Sync() error {
	if f.syncFails > 0 {
		f.syncFails--
		return &fs.PathError{Op: "sync", Path: f.Name(), Err: syscall.EIO}
	}
	return f.File.Sync()
}

func (f faultyFile) Chmod(mode fs.FileMode) error {
	if f.chmodFails > 0 {
		f.chmodFails--
		return &fs.PathError{Op: "chmod", Path: f.Name(), Err: syscall.EIO}
	}
	return f.File.Chmod(mode)
}

func (f faultyFile) Stat() (fs.FileInfo, error) {
	info, err := f.File.Stat()
	if err == nil && f.stat != nil {
		info = f.stat(info)
	}
	return info, err
}

// fakeFiles is osFiles with faults: backups go to a folder of the test.
type fakeFiles struct {
	backups            string
	openErr, createErr error
	file, backup       faults
}

func (f *fakeFiles) Open(path string) (inPlaceFile, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	return faultyFile{file, &f.file}, nil
}

func (f *fakeFiles) CreateBackup() (inPlaceFile, error) {
	if f.createErr != nil {
		return nil, f.createErr
	}
	file, err := os.CreateTemp(f.backups, "original-*")
	if err != nil {
		return nil, err
	}
	return faultyFile{file, &f.backup}, nil
}

func (f *fakeFiles) Remove(name string) error { return os.Remove(name) }

// A write in place backs the file up first and writes nothing without the
// backup; a write that fails part-way puts the original back, and when that
// fails too the backup stays and the error names it.
func TestWriteInPlace(t *testing.T) {
	original := bytes.Repeat([]byte("original line\n"), 1000)
	longer := bytes.Repeat([]byte("the new content\n"), 3000)
	shorter := []byte("short\n")
	denied := &fs.PathError{Op: "open", Path: "x", Err: syscall.EACCES}
	cases := []struct {
		name               string
		data               []byte
		files              fakeFiles
		wantCode           protocol.ReasonCode
		wantWritten        bool
		wantRestored       bool
		wantBackupKept     bool
		wantNoWriteAttempt bool
	}{
		{name: "longer", data: longer, wantWritten: true},
		{name: "shorter", data: shorter, wantWritten: true},
		{name: "empty", data: []byte{}, wantWritten: true},
		{name: "file cannot be opened", data: longer, files: fakeFiles{openErr: denied},
			wantCode: protocol.CodeComputerPermissionDenied, wantNoWriteAttempt: true},
		{name: "backup refused", data: longer, files: fakeFiles{createErr: denied},
			wantCode: protocol.CodeComputerPermissionDenied, wantNoWriteAttempt: true},
		{name: "no room for the backup", data: longer, files: fakeFiles{backup: faults{writeLimit: 4096}},
			wantCode: protocol.CodeComputerFileTooLarge, wantNoWriteAttempt: true},
		{name: "backup not durable", data: longer, files: fakeFiles{backup: faults{syncFails: 1}},
			wantCode: protocol.CodeDeviceError, wantNoWriteAttempt: true},
		{name: "disk full past the original's end", data: longer, files: fakeFiles{file: faults{writeLimit: 20_000}},
			wantCode: protocol.CodeComputerFileTooLarge, wantRestored: true},
		{name: "cut fails", data: shorter, files: fakeFiles{file: faults{truncateFails: 1}},
			wantCode: protocol.CodeDeviceError, wantRestored: true},
		{name: "not durable", data: shorter, files: fakeFiles{file: faults{syncFails: 1}},
			wantCode: protocol.CodeDeviceError, wantRestored: true},
		{name: "not put back", data: shorter, files: fakeFiles{file: faults{syncFails: 2}},
			wantCode: protocol.CodeDeviceError, wantBackupKept: true},
		// A full copy-on-write volume refuses even bytes written over.
		{name: "not put back on a full disk", data: longer, files: fakeFiles{file: faults{writeLimit: 5_000}},
			wantCode: protocol.CodeDeviceError, wantBackupKept: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "notes.txt")
			writeTestFile(t, path, original)
			files := tc.files
			files.backups = t.TempDir()
			err := writeInPlace(&files, path, tc.data)
			code := protocol.ReasonCode("")
			if err != nil {
				code = replaceCode(err)
			}
			if code != tc.wantCode {
				t.Fatalf("code %q, want %q (%v)", code, tc.wantCode, err)
			}
			got := readTestFile(t, path)
			if tc.wantWritten != bytes.Equal(got, tc.data) || !tc.wantWritten && !tc.wantBackupKept && !bytes.Equal(got, original) {
				t.Fatalf("content: %d bytes", len(got))
			}
			if tc.wantNoWriteAttempt && files.file.writes != 0 {
				t.Fatalf("the file was written without a backup")
			}
			var unchanged *unchangedError
			if restored := errors.As(err, &unchanged) && unchanged.restored; restored != tc.wantRestored {
				t.Fatalf("restored: %v (%v)", restored, err)
			}
			entries, _ := os.ReadDir(files.backups)
			var notRestored *notRestoredError
			if !tc.wantBackupKept {
				if len(entries) != 0 || errors.As(err, &notRestored) {
					t.Fatalf("backups left: %v (%v)", entries, err)
				}
				return
			}
			if len(entries) != 1 || !errors.As(err, &notRestored) {
				t.Fatalf("backups: %v (%v)", entries, err)
			}
			backup := filepath.Join(files.backups, entries[0].Name())
			if !strings.Contains(err.Error(), backup) || notRestored.backup != backup {
				t.Fatalf("the error does not name the backup: %v", err)
			}
			if kept := readTestFile(t, backup); !bytes.Equal(kept, original) {
				t.Fatalf("backup: %d bytes", len(kept))
			}
		})
	}
}

// fakeXattrs holds attributes per path; failures are injected by name.
// gone names attributes List reports that are removed before Get.
type fakeXattrs struct {
	attrs     map[string]map[string]string
	gone      []string
	listErr   error
	getErr    map[string]error
	setErr    map[string]error
	removeErr error
	sets      []string
	removed   []string
}

func (f *fakeXattrs) Remove(path, name string) error {
	f.removed = append(f.removed, path+":"+name)
	if f.removeErr != nil {
		return f.removeErr
	}
	delete(f.attrs[path], name)
	return nil
}

func (f *fakeXattrs) List(path string) ([]string, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	names := slices.Clone(f.gone)
	for name := range f.attrs[path] {
		names = append(names, name)
	}
	slices.Sort(names)
	return names, nil
}

func (f *fakeXattrs) Get(path, name string) ([]byte, bool, error) {
	if err := f.getErr[path+":"+name]; err != nil {
		return nil, false, err
	}
	value, found := f.attrs[path][name]
	return []byte(value), found, nil
}

func (f *fakeXattrs) Set(path, name string, value []byte) error {
	f.sets = append(f.sets, name)
	if err := f.setErr[name]; err != nil {
		return err
	}
	if f.attrs[path] == nil {
		f.attrs[path] = map[string]string{}
	}
	f.attrs[path][name] = string(value)
	return nil
}

func TestCopyXattrs(t *testing.T) {
	original := func() map[string]map[string]string {
		return map[string]map[string]string{
			"file": {"system.posix_acl_access": "acl", "user.tag": "red", "security.selinux": "home_t"},
			"tmp":  {"security.selinux": "home_t"},
		}
	}

	t.Run("copies every attribute but one the replacement has already", func(t *testing.T) {
		store := &fakeXattrs{attrs: original()}
		if err := copyXattrs(store, "file", "tmp"); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(store.sets, []string{"system.posix_acl_access", "user.tag"}) {
			t.Fatalf("set: %v", store.sets)
		}
		if fmt.Sprint(store.attrs["tmp"]) != fmt.Sprint(store.attrs["file"]) {
			t.Fatalf("replacement: %v", store.attrs["tmp"])
		}
	})

	t.Run("a file system without attributes renames as before", func(t *testing.T) {
		store := &fakeXattrs{attrs: original(), listErr: errXattrsUnsupported}
		if err := copyXattrs(store, "file", "tmp"); err != nil || len(store.sets) != 0 {
			t.Fatalf("err %v, set %v", err, store.sets)
		}
	})

	t.Run("an attribute that cannot be set writes in place", func(t *testing.T) {
		store := &fakeXattrs{attrs: original(), setErr: map[string]error{"user.tag": syscall.EPERM}}
		if err := copyXattrs(store, "file", "tmp"); !errors.Is(err, errWriteInPlace) {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("an attribute that cannot be read writes in place", func(t *testing.T) {
		store := &fakeXattrs{attrs: original(), getErr: map[string]error{"file:user.tag": syscall.EACCES}}
		if err := copyXattrs(store, "file", "tmp"); !errors.Is(err, errWriteInPlace) {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("a list that fails otherwise writes in place", func(t *testing.T) {
		store := &fakeXattrs{attrs: original(), listErr: syscall.EIO}
		if err := copyXattrs(store, "file", "tmp"); !errors.Is(err, errWriteInPlace) {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("an attribute gone since the list is skipped", func(t *testing.T) {
		store := &fakeXattrs{attrs: map[string]map[string]string{"file": {"user.other": "x"}}, gone: []string{"user.gone"}}
		if err := copyXattrs(store, "file", "tmp"); err != nil || !slices.Equal(store.sets, []string{"user.other"}) {
			t.Fatalf("err %v, set %v", err, store.sets)
		}
	})

	// A folder's default ACL gave the replacement an access ACL the file
	// lacks; its SELinux label stays.
	inherited := func() map[string]map[string]string {
		return map[string]map[string]string{
			"file": {"user.tag": "red", "security.selinux": "home_t"},
			"tmp":  {"system.posix_acl_access": "inherited", "security.selinux": "home_t"},
		}
	}

	t.Run("an inherited access ACL the file lacks is removed", func(t *testing.T) {
		store := &fakeXattrs{attrs: inherited()}
		if err := copyXattrs(store, "file", "tmp"); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(store.removed, []string{"tmp:system.posix_acl_access"}) || fmt.Sprint(store.attrs["tmp"]) != fmt.Sprint(store.attrs["file"]) {
			t.Fatalf("removed %v, replacement %v", store.removed, store.attrs["tmp"])
		}
	})

	t.Run("the file's own access ACL is not removed", func(t *testing.T) {
		store := &fakeXattrs{attrs: original()}
		store.attrs["tmp"]["system.posix_acl_access"] = "inherited"
		if err := copyXattrs(store, "file", "tmp"); err != nil || len(store.removed) != 0 || store.attrs["tmp"]["system.posix_acl_access"] != "acl" {
			t.Fatalf("err %v, removed %v, replacement %v", err, store.removed, store.attrs["tmp"])
		}
	})

	t.Run("an inherited access ACL that cannot be removed writes in place", func(t *testing.T) {
		store := &fakeXattrs{attrs: inherited(), removeErr: syscall.EPERM}
		if err := copyXattrs(store, "file", "tmp"); !errors.Is(err, errWriteInPlace) {
			t.Fatalf("err %v", err)
		}
	})
}

// fakeWinFiles is a folder of names; replace scripts what ReplaceFileW does.
type fakeWinFiles struct {
	files     map[string]bool
	replace   func(f *fakeWinFiles, replaced, replacement, backup string) error
	renameErr error
	removed   []string
}

func (f *fakeWinFiles) ReplaceFile(replaced, replacement, backup string) error {
	return f.replace(f, replaced, replacement, backup)
}

func (f *fakeWinFiles) Rename(from, to string) error {
	if f.renameErr != nil {
		return f.renameErr
	}
	delete(f.files, from)
	f.files[to] = true
	return nil
}

func (f *fakeWinFiles) Remove(path string) error {
	f.removed = append(f.removed, path)
	delete(f.files, path)
	return nil
}

func (f *fakeWinFiles) Exists(path string) bool { return f.files[path] }

func TestReplaceWindowsFile(t *testing.T) {
	const path, tmp = `C:\Users\ivan\notes.txt`, `C:\Users\ivan\.notes.txt.aiqsa-1`
	const backup = tmp + ".old"
	newFiles := func(replace func(f *fakeWinFiles, replaced, replacement, backup string) error) *fakeWinFiles {
		return &fakeWinFiles{files: map[string]bool{path: true, tmp: true}, replace: replace}
	}
	// moveAside is ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the replaced file
	// went to the backup, the replacement stayed.
	moveAside := func(f *fakeWinFiles, replaced, _, backup string) error {
		delete(f.files, replaced)
		f.files[backup] = true
		return syscall.Errno(1177)
	}

	files := newFiles(func(f *fakeWinFiles, replaced, replacement, backup string) error {
		if replaced != path || replacement != tmp || backup != tmp+".old" {
			t.Fatalf("names: %q %q %q", replaced, replacement, backup)
		}
		delete(f.files, replacement)
		f.files[backup] = true
		return nil
	})
	if err := replaceWindowsFile(files, tmp, path); err != nil || files.files[backup] || !files.files[path] {
		t.Fatalf("replace: %v %v", err, files.files)
	}

	for _, code := range []syscall.Errno{1, 50, 87, 120} {
		files = newFiles(func(*fakeWinFiles, string, string, string) error { return code })
		if err := replaceWindowsFile(files, tmp, path); !errors.Is(err, errWriteInPlace) {
			t.Fatalf("unsupported %d: %v", code, err)
		}
	}

	files = newFiles(func(*fakeWinFiles, string, string, string) error { return syscall.Errno(5) })
	if err := replaceWindowsFile(files, tmp, path); !errors.Is(err, syscall.Errno(5)) {
		t.Fatalf("access denied: %v", err)
	}

	files = newFiles(moveAside)
	if err := replaceWindowsFile(files, tmp, path); !errors.Is(err, syscall.Errno(1177)) || !files.files[path] || files.files[backup] {
		t.Fatalf("moved aside: %v %v", err, files.files)
	}

	// The original is never written over while it is not at path, and the
	// failure says where it is, with no definite code.
	files = newFiles(func(f *fakeWinFiles, replaced, replacement, backup string) error {
		moveAside(f, replaced, replacement, backup)
		return fs.ErrPermission
	})
	files.renameErr = syscall.Errno(32)
	err := replaceWindowsFile(files, tmp, path)
	var notRestored *notRestoredError
	if !errors.As(err, &notRestored) || notRestored.backup != backup || !files.files[backup] || len(files.removed) != 0 {
		t.Fatalf("restore failed: %v %v %v", err, files.files, files.removed)
	}
	if code := replaceCode(err); code != protocol.CodeDeviceError {
		t.Fatalf("restore failed: code %q", code)
	}

	// Something else at path beside the moved original: nothing is moved.
	files = newFiles(func(f *fakeWinFiles, _, _, backup string) error {
		f.files[backup] = true
		return syscall.Errno(50)
	})
	if err := replaceWindowsFile(files, tmp, path); !errors.As(err, &notRestored) || !files.files[backup] || !files.files[path] {
		t.Fatalf("both: %v %v", err, files.files)
	}
}

func TestWinLongPath(t *testing.T) {
	long := strings.Repeat("a", 250)
	for path, want := range map[string]string{
		`C:\Users\ivan\notes.txt`: `C:\Users\ivan\notes.txt`,
		`C:\` + long:              `\\?\C:\` + long,
		`\\server\share\` + long:  `\\?\UNC\server\share\` + long,
		`\\?\C:\` + long:          `\\?\C:\` + long,
		`C:/` + long:              `C:/` + long,
		`relative\` + long:        `relative\` + long,
	} {
		if got := winLongPath(path); got != want {
			t.Fatalf("%.20q: %.30q", path, got)
		}
	}
}
