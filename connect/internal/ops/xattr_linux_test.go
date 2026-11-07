package ops

import (
	"encoding/binary"
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
			if !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.EPERM) {
				t.Fatal(err)
			}
			// A sandbox that maps one group refuses the others.
			t.Logf("the group check is skipped: %v", err)
			group = -1
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

// posixACL encodes a POSIX ACL as Linux stores it in an extended attribute:
// version 2, then each entry's tag and permissions (uint16) and id
// (uint32), little-endian, sorted by tag.
func posixACL(entries ...[3]uint32) []byte {
	out := binary.LittleEndian.AppendUint32(nil, 2)
	for _, entry := range entries {
		out = binary.LittleEndian.AppendUint16(out, uint16(entry[0]))
		out = binary.LittleEndian.AppendUint16(out, uint16(entry[1]))
		out = binary.LittleEndian.AppendUint32(out, entry[2])
	}
	return out
}

func hasXattr(t *testing.T, path, name string) bool {
	t.Helper()
	_, err := unix.Getxattr(path, name, nil)
	if errors.Is(err, unix.ENODATA) {
		return false
	}
	if err != nil {
		t.Fatal(err)
	}
	return true
}

// A replacement created in a folder with a default ACL inherits an access
// ACL; when the file has none, it is dropped before the mode is set, so the
// file keeps its group permissions and the ACL's named user gains nothing.
// The file is still replaced through a rename.
func TestReplaceInAFolderWithADefaultACLKeepsTheFilesPermissions(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	dir := filepath.Join(home, "shared")
	path := filepath.Join(dir, "notes.txt")
	writeTestFile(t, path, []byte("old\n"))
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	const (
		userObj, namedUser, groupObj, mask, other = 0x01, 0x02, 0x04, 0x10, 0x20
		noID                                      = 0xFFFFFFFF
	)
	acl := posixACL(
		[3]uint32{userObj, 6, noID}, [3]uint32{namedUser, 6, 4242}, [3]uint32{groupObj, 0, noID},
		[3]uint32{mask, 6, noID}, [3]uint32{other, 0, noID})
	if err := unix.Setxattr(dir, "system.posix_acl_default", acl, 0); err != nil {
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EPERM) {
			t.Skipf("the temporary folder takes no default ACL: %v", err)
		}
		t.Fatal(err)
	}
	probe := filepath.Join(dir, "probe")
	writeTestFile(t, probe, nil)
	if !hasXattr(t, probe, posixACLAccess) {
		t.Skip("the file system gives new files no access ACL from the default ACL")
	}
	os.Remove(probe)
	if hasXattr(t, path, posixACLAccess) {
		t.Fatal("the original has an access ACL")
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
	if hasXattr(t, path, posixACLAccess) {
		t.Fatal("the replaced file has an access ACL")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v, want -rw-r-----", info.Mode())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
}
