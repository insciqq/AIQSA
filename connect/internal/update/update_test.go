package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// fakeBinary stands in for a client build: a script answering `version`.
func fakeBinary(version string) []byte {
	return []byte("#!/bin/sh\n[ \"$1\" = version ] && echo " + version + "\n")
}

type fakeServer struct {
	*httptest.Server
	manifestVersion string
	binary          []byte
	sum             string
	downloads       atomic.Int32
	manifestStatus  int
}

func newFakeServer(t *testing.T, version string) *fakeServer {
	t.Helper()
	f := &fakeServer{manifestVersion: version, binary: fakeBinary(version), manifestStatus: http.StatusOK}
	digest := sha256.Sum256(f.binary)
	f.sum = hex.EncodeToString(digest[:])
	goos, arch, err := Target()
	if err != nil {
		t.Skip("unsupported test platform")
	}
	name := protocol.ClientBinaryName(goos, arch)
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(protocol.ClientVersionHeader) == "" || r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("unexpected request headers: %v", r.Header)
		}
		switch r.URL.Path {
		case protocol.ClientManifestPath:
			if f.manifestStatus != http.StatusOK {
				w.WriteHeader(f.manifestStatus)
				fmt.Fprint(w, `{"code":"connect_client_unavailable"}`)
				return
			}
			json.NewEncoder(w).Encode(protocol.ClientManifest{
				Version: f.manifestVersion,
				Targets: []protocol.ClientTarget{{OS: goos, Arch: arch, SHA256: f.sum, Size: int64(len(f.binary))}},
			})
		case protocol.ClientChecksumsPath:
			fmt.Fprintf(w, "%s  %s\n%s  aiqsa-connect-other\n", f.sum, name, strings.Repeat("0", 64))
		case protocol.ClientDownloadPath(goos, arch):
			f.downloads.Add(1)
			w.Write(f.binary)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeServer) client() *Client {
	return &Client{Origin: f.URL, Version: "1.0.0", HTTP: api.NewHTTPClient()}
}

func installedBinary(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "aiqsa-connect")
	if err := os.WriteFile(path, fakeBinary("1.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(list))
	for _, entry := range list {
		names = append(names, entry.Name())
	}
	return names
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

func TestInstallFollowsADowngrade(t *testing.T) {
	server := newFakeServer(t, "0.9.0")
	path := installedBinary(t, t.TempDir())
	if _, err := server.client().Install(context.Background(), path, "0.9.0"); err != nil {
		t.Fatal(err)
	}
	out, _ := exec.Command(path, "version").Output()
	if strings.TrimSpace(string(out)) != "0.9.0" {
		t.Fatalf("version = %q", out)
	}
}

func TestInstallKeepsTheBinaryOnEveryFailure(t *testing.T) {
	cases := map[string]struct {
		prepare   func(*fakeServer)
		announced string
		want      string
		permanent bool
	}{
		"checksum mismatch":         {func(f *fakeServer) { f.binary = fakeBinary("1.1.1") }, "1.1.0", "SHA-256", false},
		"announced version differs": {func(*fakeServer) {}, "1.2.0", "offers aiqsa-connect 1.1.0", true},
		"binary reports another version": {func(f *fakeServer) {
			f.binary = fakeBinary("2.0.0")
			digest := sha256.Sum256(f.binary)
			f.sum = hex.EncodeToString(digest[:])
		}, "", "reports version", true},
		"development build":      {func(f *fakeServer) { f.manifestVersion = "dev" }, "", "development build", true},
		"server has no binaries": {func(f *fakeServer) { f.manifestStatus = http.StatusServiceUnavailable }, "1.1.0", "connect_client_unavailable", false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			server := newFakeServer(t, "1.1.0")
			tc.prepare(server)
			dir := t.TempDir()
			path := installedBinary(t, dir)
			want := tc.announced
			_, err := server.client().Install(context.Background(), path, want)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
			if Permanent(err) != tc.permanent {
				t.Fatalf("Permanent(%v) = %v", err, !tc.permanent)
			}
			data, _ := os.ReadFile(path)
			if string(data) != string(fakeBinary("1.0.0")) {
				t.Fatal("the binary was replaced")
			}
			if got := entries(t, dir); len(got) != 1 {
				t.Fatalf("left files behind: %v", got)
			}
		})
	}
}

func TestInstallReportsAnUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write any directory")
	}
	server := newFakeServer(t, "1.1.0")
	dir := t.TempDir()
	path := installedBinary(t, dir)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	_, err := server.client().Install(context.Background(), path, "1.1.0")
	if !errors.Is(err, ErrNotWritable) || !Permanent(err) {
		t.Fatalf("err = %v", err)
	}
	if server.downloads.Load() != 0 {
		t.Fatal("downloaded although the binary cannot be replaced")
	}
}

func TestManifestDecodesStrictly(t *testing.T) {
	server := newFakeServer(t, "1.1.0")
	manifest, err := server.client().Manifest(context.Background())
	if err != nil || manifest.Version != "1.1.0" || len(manifest.Targets) != 1 {
		t.Fatalf("manifest = %+v, %v", manifest, err)
	}
	var refusal *Refusal
	server.manifestStatus = http.StatusForbidden
	if _, err := server.client().Manifest(context.Background()); !errors.As(err, &refusal) || refusal.Status != http.StatusForbidden {
		t.Fatalf("err = %v", err)
	}
}
