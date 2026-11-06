package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// withRenameAside checks the Windows way of replacing the binary.
func withRenameAside(t *testing.T) {
	t.Helper()
	previous := renameAside
	renameAside = true
	t.Cleanup(func() { renameAside = previous })
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestTargetCoversWindowsWithExeNames(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		goos, got, err := targetFor("windows", arch)
		if err != nil || goos != protocol.OSWindows || string(got) != arch {
			t.Fatalf("windows/%s: %s %s %v", arch, goos, got, err)
		}
		if name := protocol.ClientBinaryName(goos, got); name != "aiqsa-connect-windows-"+arch+".exe" {
			t.Fatalf("name = %s", name)
		}
	}
	if _, _, err := targetFor("windows", "386"); err != ErrUnsupported {
		t.Fatalf("windows/386: %v", err)
	}
	if _, _, err := targetFor("freebsd", "amd64"); err != ErrUnsupported {
		t.Fatalf("freebsd: %v", err)
	}
}

func TestWindowsInstallMovesTheRunningBinaryAside(t *testing.T) {
	withRenameAside(t)
	server := newFakeServer(t, "1.1.0")
	dir := t.TempDir()
	path := installedBinary(t, dir)
	// A stale .old from an earlier update is replaced.
	if err := os.WriteFile(OldPath(path), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := server.client().Install(context.Background(), path, "1.1.0")
	if err != nil || result.Path != path || result.Version != "1.1.0" {
		t.Fatalf("install: %+v %v", result, err)
	}
	if readFile(t, path) != string(fakeBinary("1.1.0")) {
		t.Fatal("the new version is not in place")
	}
	if readFile(t, OldPath(path)) != string(fakeBinary("1.0.0")) {
		t.Fatal("the running version was not kept as .old")
	}
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect", "aiqsa-connect.old"}) {
		t.Fatalf("files: %v", got)
	}
	RemoveStaleOld(path)
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect"}) {
		t.Fatalf("after the next start: %v", got)
	}
	RemoveStaleOld(path) // nothing left to remove
}

func TestWindowsInstallLeavesTheRunningBinaryOnAChecksumMismatch(t *testing.T) {
	withRenameAside(t)
	server := newFakeServer(t, "1.1.0")
	server.binary = fakeBinary("1.1.1") // the manifest's checksum no longer matches
	dir := t.TempDir()
	path := installedBinary(t, dir)
	// A download left by an interrupted attempt does not survive either.
	if err := os.WriteFile(NewPath(path), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := server.client().Install(context.Background(), path, "1.1.0")
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("err = %v", err)
	}
	if readFile(t, path) != string(fakeBinary("1.0.0")) {
		t.Fatal("the running binary changed")
	}
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect"}) {
		t.Fatalf("left files behind: %v", got)
	}
}

func TestWindowsInstallKeepsTheBinaryWhenTheDownloadDoesNotRun(t *testing.T) {
	withRenameAside(t)
	server := newFakeServer(t, "1.1.0")
	server.binary = []byte("#!/bin/sh\nexit 1\n")
	digest := sha256.Sum256(server.binary)
	server.sum = hex.EncodeToString(digest[:])
	dir := t.TempDir()
	path := installedBinary(t, dir)
	if _, err := server.client().Install(context.Background(), path, "1.1.0"); err == nil {
		t.Fatal("installed a binary that does not run")
	}
	if readFile(t, path) != string(fakeBinary("1.0.0")) {
		t.Fatal("the running binary changed")
	}
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect"}) {
		t.Fatalf("left files behind: %v", got)
	}
}

func TestStagingNamesKeepTheExeExtension(t *testing.T) {
	if got := NewPath(`C:\Users\a\AppData\Local\Programs\AIQSA Connect\aiqsa-connect.exe`); got != `C:\Users\a\AppData\Local\Programs\AIQSA Connect\aiqsa-connect.new.exe` {
		t.Fatalf("new = %s", got)
	}
	if got := OldPath(`C:\p\aiqsa-connect.exe`); got != `C:\p\aiqsa-connect.exe.old` {
		t.Fatalf("old = %s", got)
	}
	if got := NewPath("/usr/local/bin/aiqsa-connect"); got != "/usr/local/bin/aiqsa-connect.new" {
		t.Fatalf("new = %s", got)
	}
}

func TestSwapInUndoesTheMoveWhenTheNewFileIsMissing(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "aiqsa-connect.exe")
	if err := os.WriteFile(exe, []byte("running"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SwapIn(filepath.Join(dir, "missing.new"), exe); err == nil {
		t.Fatal("swapped in a missing file")
	}
	if readFile(t, exe) != "running" {
		t.Fatal("the running file was not put back")
	}
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect.exe"}) {
		t.Fatalf("files: %v", got)
	}
}

func TestSwapInPlacesAFirstCopy(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "aiqsa-connect.exe")
	if err := os.WriteFile(NewPath(exe), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SwapIn(NewPath(exe), exe); err != nil {
		t.Fatal(err)
	}
	if got := entries(t, dir); !slices.Equal(got, []string{"aiqsa-connect.exe"}) || readFile(t, exe) != "new" {
		t.Fatalf("files: %v", got)
	}
}

func TestSwapInRefusesWhileAnOlderCopyCannotBeRemoved(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "aiqsa-connect.exe")
	for path, content := range map[string]string{exe: "running", NewPath(exe): "new"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A directory named .old stands in for an .old that Windows keeps
	// locked while an older process runs from it.
	if err := os.Mkdir(OldPath(exe), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(OldPath(exe), "busy"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SwapIn(NewPath(exe), exe); err == nil {
		t.Fatal("swapped while the older copy is in use")
	}
	if readFile(t, exe) != "running" || readFile(t, NewPath(exe)) != "new" {
		t.Fatal("files changed")
	}
}
