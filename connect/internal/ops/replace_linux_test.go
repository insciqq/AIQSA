package ops

import (
	"bytes"
	"errors"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

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
				return replaceFile(Native(), path, bytes.Repeat([]byte("new text\n"), 16<<10/9), info)
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
