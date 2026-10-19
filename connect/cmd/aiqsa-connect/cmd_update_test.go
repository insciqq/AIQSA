package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/update"
)

type fakeUpdateSource struct {
	mu       sync.Mutex
	manifest protocol.ClientManifest
	err      error
	installs []string
	done     chan struct{}
}

func (f *fakeUpdateSource) Manifest(context.Context) (protocol.ClientManifest, error) {
	return f.manifest, nil
}

func (f *fakeUpdateSource) Install(_ context.Context, executable, want string) (update.Result, error) {
	f.mu.Lock()
	f.installs = append(f.installs, want)
	f.mu.Unlock()
	if f.done != nil {
		defer func() { f.done <- struct{}{} }()
	}
	if f.err != nil {
		return update.Result{}, f.err
	}
	return update.Result{Version: f.manifest.Version, Path: executable}, nil
}

func (f *fakeUpdateSource) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.installs)
}

func withClientVersion(t *testing.T, v string) {
	t.Helper()
	previous := version
	version = v
	t.Cleanup(func() { version = previous })
}

func withUpdateSource(t *testing.T, source *fakeUpdateSource) {
	t.Helper()
	previous := newUpdateClient
	newUpdateClient = func(string) updateSource { return source }
	t.Cleanup(func() { newUpdateClient = previous })
}

type syncWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *syncWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func boundUpdater(t *testing.T, source *fakeUpdateSource) (*autoUpdater, context.Context, *syncWriter) {
	t.Helper()
	withUpdateSource(t, source)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	notices := &syncWriter{}
	u := &autoUpdater{}
	u.bindUp(ctx, cancel, "https://ai.example.com", logx.Discard(), notices)
	return u, ctx, notices
}

// waitInstall waits for one attempt and for the updater to record its outcome.
func waitInstall(t *testing.T, u *autoUpdater, source *fakeUpdateSource) {
	t.Helper()
	select {
	case <-source.done:
	case <-time.After(5 * time.Second):
		t.Fatal("no update attempt")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		u.mu.Lock()
		busy := u.busy
		u.mu.Unlock()
		if !busy {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the update attempt did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAutoUpdateFollowsTheServerOncePerVersionAndReExecs(t *testing.T) {
	withClientVersion(t, "1.0.0")
	source := &fakeUpdateSource{manifest: protocol.ClientManifest{Version: "0.9.0"}, done: make(chan struct{}, 4)}
	u, ctx, notices := boundUpdater(t, source)

	u.OnServerVersion("1.0.0", "0.3.20")
	u.OnServerVersion("dev", "0.3.20")
	if source.count() != 0 {
		t.Fatal("updated although the versions match or the server is a development build")
	}
	// An older server is followed too.
	u.OnServerVersion("0.9.0", "0.3.20")
	waitInstall(t, u, source)
	u.OnServerVersion("0.9.0", "0.3.20")
	if got := source.count(); got != 1 || source.installs[0] != "0.9.0" {
		t.Fatalf("installs = %v", source.installs)
	}
	if ctx.Err() == nil {
		t.Fatal("the daemon was not stopped for the restart")
	}
	if !strings.Contains(notices.String(), "Updated aiqsa-connect from 1.0.0 to 0.9.0; restarting.") {
		t.Fatalf("notices: %q", notices.String())
	}

	var execPath string
	var execArgs []string
	previous := updateExec
	updateExec = func(path string, argv, env []string) error {
		execPath, execArgs = path, argv
		return errors.New("exec refused in test")
	}
	t.Cleanup(func() { updateExec = previous })
	var stderr bytes.Buffer
	code, restarted := u.restartUpdated(&stderr)
	if !restarted || code != 1 || !strings.Contains(stderr.String(), "cannot restart the updated client") {
		t.Fatalf("restart: %d %v %q", code, restarted, stderr.String())
	}
	if execPath != selfExecutable() || strings.Join(execArgs[1:], " ") != strings.Join(os.Args[1:], " ") || execArgs[0] != execPath {
		t.Fatalf("exec %q %q", execPath, execArgs)
	}
}

func TestAutoUpdateFailureKeepsRunning(t *testing.T) {
	withClientVersion(t, "1.0.0")
	source := &fakeUpdateSource{
		manifest: protocol.ClientManifest{Version: "1.1.0"},
		err:      errors.Join(update.ErrNotWritable, errors.New("/opt/bin")),
		done:     make(chan struct{}, 2),
	}
	u, ctx, notices := boundUpdater(t, source)
	u.OnServerVersion("1.1.0", "0.3.20")
	waitInstall(t, u, source)
	if ctx.Err() != nil {
		t.Fatal("a failed update stopped the daemon")
	}
	if !strings.Contains(notices.String(), "could not update itself") || !strings.Contains(notices.String(), "keeps running version 1.0.0") {
		t.Fatalf("notices: %q", notices.String())
	}
	if _, restarted := u.restartUpdated(&bytes.Buffer{}); restarted {
		t.Fatal("restarted without an update")
	}
	// One attempt per server version: a reconnect does not retry.
	u.OnServerVersion("1.1.0", "0.3.20")
	if source.count() != 1 {
		t.Fatalf("installs = %v", source.installs)
	}
}

func TestDevelopmentClientNeverUpdatesItself(t *testing.T) {
	withClientVersion(t, "dev")
	source := &fakeUpdateSource{manifest: protocol.ClientManifest{Version: "1.1.0"}}
	u, _, _ := boundUpdater(t, source)
	u.OnServerVersion("1.1.0", "0.3.20")
	u.mu.Lock()
	busy := u.busy
	u.mu.Unlock()
	if busy || source.count() != 0 {
		t.Fatal("a development build updated itself")
	}
	if code, _, stderr := runArgs("update"); code != 1 || !strings.Contains(stderr, "development build") {
		t.Fatalf("update: %d %q", code, stderr)
	}
}

func TestUpdateCommand(t *testing.T) {
	withClientVersion(t, "1.0.0")
	paths := isolate(t)
	if code, _, stderr := runArgs("update"); code != 1 || !strings.Contains(stderr, "aiqsa-connect login") {
		t.Fatalf("not logged in: %d %q", code, stderr)
	}
	writeCredentials(t, paths, "https://ai.example.com")
	source := &fakeUpdateSource{manifest: protocol.ClientManifest{Version: "1.0.0"}}
	withUpdateSource(t, source)
	if code, stdout, _ := runArgs("update"); code != 0 || !strings.Contains(stdout, "is the version https://ai.example.com offers") || source.count() != 0 {
		t.Fatalf("up to date: %d %q", code, stdout)
	}
	source.manifest.Version = "1.2.0"
	code, stdout, stderr := runArgs("update")
	if code != 0 || !strings.Contains(stdout, "Updated aiqsa-connect from 1.0.0 to 1.2.0") || source.installs[0] != "1.2.0" {
		t.Fatalf("update: %d %q %q", code, stdout, stderr)
	}
	source.err = errors.Join(update.ErrNotWritable, errors.New("/opt/bin"))
	if code, _, stderr := runArgs("update"); code != 1 || !strings.Contains(stderr, "reinstall aiqsa-connect into a directory you own") {
		t.Fatalf("not writable: %d %q", code, stderr)
	}
	if code, _, _ := runArgs("update", "now"); code != 2 {
		t.Fatalf("extra argument accepted: %d", code)
	}
}
