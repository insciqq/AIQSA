package ops

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// A user extended attribute and the file's group survive write and edit,
// which still replace the file through a rename.
func TestWriteAndEditKeepExtendedAttributesAndGroup(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "notes.txt")
	writeTestFile(t, path, []byte("old\n"))
	const name, value = "user.aiqsa_test", "kept"
	if err := unix.Setxattr(path, name, []byte(value), 0); err != nil {
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EPERM) {
			t.Skipf("the temporary folder takes no user attributes: %v", err)
		}
		t.Fatal(err)
	}
	// A group of the user other than the one new files get, when there is one.
	group := -1
	if groups, err := os.Getgroups(); err == nil {
		for _, g := range groups {
			if g != os.Getegid() {
				group = g
				break
			}
		}
	}
	if group != -1 {
		if err := os.Chown(path, -1, group); err != nil {
			t.Fatal(err)
		}
	}
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"})
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "new", NewString: "newer"})

	if got := readTestFile(t, path); string(got) != "newer\n" {
		t.Fatalf("content: %q", got)
	}
	if old, _ := io.ReadAll(held); string(old) != "old\n" {
		t.Fatalf("written in place, not renamed: %q", old)
	}
	buf := make([]byte, 64)
	n, err := unix.Getxattr(path, name, buf)
	if err != nil || string(buf[:n]) != value {
		t.Fatalf("attribute: %q %v", buf[:n], err)
	}
	if group != -1 {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if gid := int(info.Sys().(*syscall.Stat_t).Gid); gid != group {
			t.Fatalf("group %d, want %d", gid, group)
		}
	}
	if entries, _ := os.ReadDir(home); len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
}
