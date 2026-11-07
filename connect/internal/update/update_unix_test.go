//go:build !windows

package update

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
)

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

func TestInstallReplacesTheBinaryAtomically(t *testing.T) {
	server := newFakeServer(t, "1.1.0")
	dir := t.TempDir()
	path := installedBinary(t, dir)
	before := inode(t, path)
	// A running process keeps the old file open; the rename must not change it.
	old, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()

	result, err := server.client().Install(context.Background(), path, "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != "1.1.0" || result.Path != path {
		t.Fatalf("result = %+v", result)
	}
	if inode(t, path) == before {
		t.Fatal("the binary was rewritten in place instead of renamed over")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v", info.Mode())
	}
	out, err := exec.Command(path, "version").Output()
	if err != nil || strings.TrimSpace(string(out)) != "1.1.0" {
		t.Fatalf("installed binary reports %q (%v)", out, err)
	}
	oldData := make([]byte, 64)
	n, _ := old.ReadAt(oldData, 0)
	if !strings.Contains(string(oldData[:n]), "1.0.0") {
		t.Fatal("the running binary's file changed")
	}
	if got := entries(t, dir); len(got) != 1 {
		t.Fatalf("left files behind: %v", got)
	}
}
