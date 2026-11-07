package ops

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// setuidMode is a program's mode with setuid and setgid, which the kernel
// clears when a process without CAP_FSETID writes the file.
const setuidMode = 0o755 | fs.ModeSetuid | fs.ModeSetgid

// setuidFile writes a file with setuidMode; the test is skipped as root,
// whose writes keep the bits, or where the bits do not hold.
func setuidFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root's writes keep setuid and setgid")
	}
	writeTestFile(t, path, data)
	if err := os.Chmod(path, setuidMode); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode()&keptModeBits != setuidMode {
		t.Skipf("the temporary folder does not keep setuid and setgid: %v", err)
	}
}

func modeOf(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode() & keptModeBits
}

// A program written or edited in place keeps its setuid and setgid bits,
// which the kernel clears on the write.
func TestWriteInPlaceKeepsSetuidAndSetgid(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{inPlace: true})
	t.Setenv("TMPDIR", t.TempDir())
	path := filepath.Join(home, "tool.sh")
	setuidFile(t, path, []byte("echo old\n"))
	probe := filepath.Join(home, "probe")
	setuidFile(t, probe, nil)
	if err := os.WriteFile(probe, []byte("x"), 0); err != nil {
		t.Fatal(err)
	}
	if modeOf(t, probe) == setuidMode {
		t.Log("this kernel kept setuid on a write; the test shows only that the mode stays")
	}

	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "echo new\n"})
	if got := modeOf(t, path); got != setuidMode {
		t.Fatalf("after write: mode %v", got)
	}
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "new", NewString: "newer"})
	if got := modeOf(t, path); got != setuidMode {
		t.Fatalf("after edit: mode %v", got)
	}
	if got := readTestFile(t, path); string(got) != "echo newer\n" {
		t.Fatalf("content %q", got)
	}
}

// The review's reproduction: a program replaced through a rename lost its
// setuid and setgid bits (ugrwxr-xr-x became -rwxr-xr-x), as the data
// went into the replacement after its mode was set and the kernel cleared
// them. The data now goes in first, and the mode is set and checked last.
func TestReplaceKeepsSetuidAndSetgid(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "tool.sh")
	setuidFile(t, path, []byte("echo old\n"))
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "echo new\n"})
	if got := modeOf(t, path); got != setuidMode {
		t.Fatalf("after write: mode %v", got)
	}
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "new", NewString: "newer"})
	if got := modeOf(t, path); got != setuidMode {
		t.Fatalf("after edit: mode %v", got)
	}
	if got := readTestFile(t, path); string(got) != "echo newer\n" {
		t.Fatalf("content %q", got)
	}
	if old, _ := io.ReadAll(held); string(old) != "echo old\n" {
		t.Fatalf("the file was written in place, not replaced: %q", old)
	}
	if entries, _ := os.ReadDir(home); len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
}

// A file whose setuid, setgid or sticky bits the process could not put
// back on a replacement is refused before anything changes, as a write in
// place refuses it: computer_permission_denied, and no replacement left.
func TestReplaceRefusesSpecialBitsItCannotKeep(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root keeps every bit")
	}
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	foreignGroup := uint32(4_000_000)
	for groups, _ := os.Getgroups(); slices.Contains(groups, int(foreignGroup)) || foreignGroup == gid; foreignGroup++ {
	}
	for _, tc := range []struct {
		name     string
		mode     fs.FileMode
		uid, gid uint32
	}{
		{"setgid for another group", 0o755 | fs.ModeSetgid, uid, foreignGroup},
		{"another user's setuid file", 0o755 | fs.ModeSetuid, uid + 1, gid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TMPDIR", t.TempDir())
			path := filepath.Join(dir, "tool")
			writeTestFile(t, path, []byte("echo old\n"))
			real, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			info := fakeStat{FileInfo: real, mode: tc.mode, st: syscall.Stat_t{Uid: tc.uid, Gid: tc.gid}}
			err = replaceFile(Native(), osFiles{}, path, []byte("echo new\n"), info)
			if code := replaceCode(err); code != protocol.CodeComputerPermissionDenied || !errors.Is(err, errModeNotKept) {
				t.Fatalf("code %q (%v)", code, err)
			}
			if got := readTestFile(t, path); string(got) != "echo old\n" {
				t.Fatalf("content %q", got)
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 1 {
				t.Fatalf("left files behind: %v", entries)
			}
		})
	}
}

// fakeStat is a FileInfo with another mode and owner.
type fakeStat struct {
	fs.FileInfo
	mode fs.FileMode
	st   syscall.Stat_t
}

func (i fakeStat) Mode() fs.FileMode { return i.mode }
func (i fakeStat) Sys() any          { return &i.st }

// After a write in place, and after putting the original back from a
// failed one, the file's mode is put back too: when that fails, the file
// changed and the code is connect_device_error. A file whose setuid bit
// the process could not put back is refused before anything changes.
func TestWriteInPlaceKeepsTheModeOrSaysItChanged(t *testing.T) {
	original := bytes.Repeat([]byte("original line\n"), 1000)
	longer := bytes.Repeat([]byte("the new content\n"), 3000)
	foreignOwner := func(info fs.FileInfo) fs.FileInfo {
		st := *info.Sys().(*syscall.Stat_t)
		st.Uid = uint32(os.Geteuid() + 1)
		return fakeStat{FileInfo: info, mode: info.Mode(), st: st}
	}
	cases := []struct {
		name        string
		files       fakeFiles
		wantCode    protocol.ReasonCode
		wantContent []byte
		// wantModeKept is false where the kernel's clearing stays.
		wantModeKept bool
		wantNoWrite  bool
	}{
		{name: "written", wantContent: longer, wantModeKept: true},
		{name: "put back after a full disk", files: fakeFiles{file: faults{writeLimit: 20_000}},
			wantCode: protocol.CodeComputerFileTooLarge, wantContent: original, wantModeKept: true},
		{name: "mode not put back after the write", files: fakeFiles{file: faults{chmodFails: 1}},
			wantCode: protocol.CodeDeviceError, wantContent: longer},
		{name: "mode not put back after the original", files: fakeFiles{file: faults{writeLimit: 20_000, chmodFails: 1}},
			wantCode: protocol.CodeDeviceError, wantContent: original},
		{name: "another user's file", files: fakeFiles{file: faults{stat: foreignOwner}},
			wantCode: protocol.CodeComputerPermissionDenied, wantContent: original, wantModeKept: true, wantNoWrite: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "tool")
			setuidFile(t, path, original)
			files := tc.files
			files.backups = t.TempDir()
			err := writeInPlace(&files, path, longer)
			code := protocol.ReasonCode("")
			if err != nil {
				code = replaceCode(err)
			}
			if code != tc.wantCode {
				t.Fatalf("code %q, want %q (%v)", code, tc.wantCode, err)
			}
			if got := readTestFile(t, path); !bytes.Equal(got, tc.wantContent) {
				t.Fatalf("content: %d bytes", len(got))
			}
			if kept := modeOf(t, path) == setuidMode; kept != tc.wantModeKept {
				t.Fatalf("mode %v", modeOf(t, path))
			}
			if tc.wantNoWrite && files.file.writes != 0 {
				t.Fatal("the file was written")
			}
			if entries, _ := os.ReadDir(files.backups); len(entries) != 0 {
				t.Fatalf("backups left: %v", entries)
			}
		})
	}
}

func TestCanKeepSpecialBits(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root keeps every bit")
	}
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	foreignGroup := uint32(4_000_000)
	for groups, _ := os.Getgroups(); slices.Contains(groups, int(foreignGroup)) || foreignGroup == gid; foreignGroup++ {
	}
	for _, tc := range []struct {
		name     string
		mode     fs.FileMode
		uid, gid uint32
		want     bool
	}{
		{"own file and group", setuidMode, uid, gid, true},
		{"another user's file", 0o755 | fs.ModeSetuid, uid + 1, gid, false},
		{"another user's sticky file", 0o644 | fs.ModeSticky, uid + 1, gid, false},
		{"setgid for another group", 0o755 | fs.ModeSetgid, uid, foreignGroup, false},
		{"setuid in another group", 0o755 | fs.ModeSetuid, uid, foreignGroup, true},
	} {
		info := fakeStat{mode: tc.mode, st: syscall.Stat_t{Uid: tc.uid, Gid: tc.gid}}
		if got := canKeepSpecialBits(info); got != tc.want {
			t.Errorf("%s: %v", tc.name, got)
		}
	}
}

// withFileSizeLimit runs f under RLIMIT_FSIZE limit, with SIGXFSZ ignored,
// so a write past it fails with EFBIG as a full disk or a quota would.
func withFileSizeLimit(t *testing.T, limit uint64, f func() error) error {
	t.Helper()
	signal.Ignore(syscall.SIGXFSZ)
	defer signal.Reset(syscall.SIGXFSZ)
	var previous unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_FSIZE, &previous); err != nil {
		t.Fatal(err)
	}
	if err := unix.Setrlimit(unix.RLIMIT_FSIZE, &unix.Rlimit{Cur: limit, Max: previous.Max}); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := unix.Setrlimit(unix.RLIMIT_FSIZE, &previous); err != nil {
			t.Fatal(err)
		}
	}()
	return f()
}

// The review's reproduction: in a folder the user cannot create files in,
// the file is written in place, and a file size limit stops that write
// part-way, as a full disk or a quota would. The original stays whole and
// the write answers a definite computer_file_too_large: an 8 KiB file
// cannot be backed up under a 4 KiB limit, so nothing is written; a 2 KiB
// one is, so the write starts and the original is put back.
func TestWriteInPlaceStoppedByAFileSizeLimitKeepsTheFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root creates files in read-only folders")
	}
	for name, size := range map[string]int{"no room for the backup": 8 << 10, "put back": 2 << 10} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			backups := t.TempDir()
			t.Setenv("TMPDIR", backups)
			path := filepath.Join(dir, "notes.txt")
			original := bytes.Repeat([]byte("original\n"), size/9+1)[:size]
			writeTestFile(t, path, original)
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(dir, 0o555); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Chmod(dir, 0o755) })

			err = withFileSizeLimit(t, 4096, func() error {
				return replaceFile(Native(), osFiles{}, path, bytes.Repeat([]byte("new text\n"), 16<<10/9), info)
			})
			if err == nil {
				t.Fatal("the write passed the file size limit")
			}
			if code := replaceCode(err); code != protocol.CodeComputerFileTooLarge {
				t.Fatalf("code %q (%v)", code, err)
			}
			var unchanged *unchangedError
			if restored := errors.As(err, &unchanged) && unchanged.restored; restored != (name == "put back") {
				t.Fatalf("restored: %v (%v)", restored, err)
			}
			if got := readTestFile(t, path); !bytes.Equal(got, original) {
				t.Fatalf("the original became %d bytes", len(got))
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
