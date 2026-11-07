package ops

import (
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
// is attached to it; any other failure leaves the file as it was.
func TestReplaceFileFallsBackToWritingInPlace(t *testing.T) {
	permission := &fs.PathError{Op: "replace", Path: "x", Err: fs.ErrPermission}
	cases := []struct {
		name        string
		prepare     error
		replace     error
		wantCode    protocol.ReasonCode
		wantInPlace bool
		wantReplace bool
	}{
		{name: "attributes kept", wantReplace: true},
		{name: "attributes cannot be kept", prepare: errWriteInPlace, wantInPlace: true},
		{name: "volume cannot replace", replace: errWriteInPlace, wantInPlace: true, wantReplace: true},
		{name: "prepare fails", prepare: errors.New("io"), wantCode: protocol.CodeDeviceError},
		{name: "replace fails", replace: permission, wantCode: protocol.CodeComputerPermissionDenied, wantReplace: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			replaced := false
			e, home := newTestExecutor(t, testSystem{
				prepare: func(*os.File, string, fs.FileInfo) error { return tc.prepare },
				replace: func(tmp, path string) error {
					replaced = true
					if tc.replace != nil {
						return tc.replace
					}
					return os.Rename(tmp, path)
				},
			})
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
			if replaced != tc.wantReplace {
				t.Fatalf("replace called: %v", replaced)
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
		})
	}
}

// fakeXattrs holds attributes per path; failures are injected by name.
// gone names attributes List reports that are removed before Get.
type fakeXattrs struct {
	attrs   map[string]map[string]string
	gone    []string
	listErr error
	getErr  map[string]error
	setErr  map[string]error
	sets    []string
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

	// The original is never written over while it is not at path.
	files = newFiles(func(f *fakeWinFiles, replaced, replacement, backup string) error {
		moveAside(f, replaced, replacement, backup)
		return syscall.Errno(50)
	})
	files.renameErr = syscall.Errno(32)
	if err := replaceWindowsFile(files, tmp, path); errors.Is(err, errWriteInPlace) || !files.files[backup] || len(files.removed) != 0 {
		t.Fatalf("restore failed: %v %v %v", err, files.files, files.removed)
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
