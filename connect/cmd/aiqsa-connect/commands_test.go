package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/daemon"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
	"github.com/insciqq/AIQSA/connect/internal/tmux/tmuxtest"
)

const (
	testPairingID = "11111111-2222-4333-8444-555555555555"
	testDeviceID  = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11"
)

var (
	testPollSecret = strings.Repeat("s", 43)
	testToken      = "aiqsa_connect_" + strings.Repeat("T", 43)
)

func isolate(t *testing.T) config.Paths {
	t.Helper()
	t.Setenv(config.EnvConfigDir, filepath.Join(t.TempDir(), "config"))
	t.Setenv(config.EnvStateDir, filepath.Join(t.TempDir(), "state"))
	t.Setenv(config.EnvTmuxSocket, "aiqsa-connect-test-unused")
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestUsageListsTheClientCommands(t *testing.T) {
	_, stdout, _ := runArgs("help")
	for _, name := range []string{"login <origin>", "up", "attach <session-id>", "sessions", "logout", "version", "update", "service install|uninstall|status"} {
		if !strings.Contains(stdout, name) {
			t.Errorf("usage lacks %q:\n%s", name, stdout)
		}
	}
}

func TestLoginPairsAndStoresPrivateCredentials(t *testing.T) {
	paths := isolate(t)
	loginPairOptions = api.PairOptions{Sleep: func(context.Context, time.Duration) error { return nil }}
	t.Cleanup(func() { loginPairOptions = api.PairOptions{} })
	var polls atomic.Int32
	var created protocol.PairingCreateRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(protocol.ClientVersionHeader) != version || r.Header.Get("Origin") != "" {
			t.Errorf("headers: %v", r.Header)
		}
		data, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case protocol.PairingsPath:
			if err := protocol.Decode(data, &created); err != nil {
				t.Errorf("create: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(protocol.PairingCreateResponse{
				PairingID: testPairingID, UserCode: "ABCD-EFGH", VerificationURI: "http://" + r.Host + "/connect/pair?code=ABCD-EFGH",
				PollSecret: testPollSecret, ExpiresAt: protocol.FormatTimestamp(time.Now().Add(time.Minute)), IntervalSeconds: 2,
			})
		case protocol.PairingPollPath:
			if polls.Add(1) < 3 {
				io.WriteString(w, `{"status":"pending"}`)
				return
			}
			fmt.Fprintf(w, `{"status":"approved","deviceId":%q,"deviceToken":%q,"account":"owner@example.test (\"Owner\")"}`, testDeviceID, testToken)
		}
	}))
	defer srv.Close()
	code, stdout, stderr := runArgs("login", srv.URL+"/", "--name", "Work laptop")
	if code != 0 {
		t.Fatalf("login: %d %q %q", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "Open "+srv.URL+"/connect/pair?code=ABCD-EFGH and approve this computer. Code: ABCD-EFGH") ||
		!strings.Contains(stdout, `as "Work laptop" for the account owner@example.test ("Owner").`) {
		t.Fatalf("stdout: %q", stdout)
	}
	if created.Name != "Work laptop" || created.Hostname == "" || created.ClientVersion != version {
		t.Fatalf("pairing request: %+v", created)
	}
	info, err := os.Stat(paths.CredentialsFile())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file: %v %v", info, err)
	}
	creds, err := paths.LoadCredentials()
	if err != nil || creds.Origin != srv.URL || creds.DeviceID != testDeviceID || creds.DeviceToken != testToken {
		t.Fatalf("credentials: %+v %v", creds, err)
	}
	if strings.Contains(stdout+stderr, testToken) {
		t.Fatal("token printed")
	}

	code, stdout, _ = runArgs("logout")
	if code != 0 || !strings.Contains(stdout, "revoke this computer in AIQSA → AIQSA Connect") {
		t.Fatalf("logout: %d %q", code, stdout)
	}
	if _, err := paths.LoadCredentials(); err != config.ErrNotLoggedIn {
		t.Fatalf("after logout: %v", err)
	}
}

func TestLoginRefusesBadArguments(t *testing.T) {
	isolate(t)
	for _, args := range [][]string{
		{"login"}, {"login", "http://8.8.8.8"}, {"login", "https://ai.example.com/path"},
		{"login", "https://a", "https://b"}, {"login", "https://a", "--name"}, {"login", "https://a", "--name", "bad\nname"},
		{"login", "https://a", "--name", strings.Repeat("n", 65)}, {"login", "https://a", "--bogus"},
	} {
		if code, _, _ := runArgs(args...); code != 2 {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}

func writeCredentials(t *testing.T, paths config.Paths, origin string) {
	t.Helper()
	if err := paths.SaveCredentials(config.Credentials{Origin: origin, DeviceID: testDeviceID, DeviceToken: testToken}); err != nil {
		t.Fatal(err)
	}
}

func TestUpRefusesMissingAndReadableCredentials(t *testing.T) {
	paths := isolate(t)
	// Not logged in is final for a service manager, like a revoked device.
	if code, _, stderr := runArgs("up"); code != exitNoRestart || !strings.Contains(stderr, "not logged in — run aiqsa-connect login") {
		t.Fatalf("not logged in: %d %q", code, stderr)
	}
	writeCredentials(t, paths, "https://ai.example.com")
	os.Chmod(paths.CredentialsFile(), 0o644)
	if code, _, stderr := runArgs("up"); code != exitNoRestart || !strings.Contains(stderr, "chmod 600") {
		t.Fatalf("readable credentials: %d %q", code, stderr)
	}
}

func TestUpExitsWithStatus3WhenRevoked(t *testing.T) {
	tmuxtest.New(t)
	paths, _ := config.ResolvePaths()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"code":"connect_unauthorized"}`)
	}))
	defer srv.Close()
	writeCredentials(t, paths, srv.URL)
	code, _, stderr := runArgs("up")
	if code != exitNoRestart || !strings.Contains(stderr, "device revoked — run aiqsa-connect login") {
		t.Fatalf("revoked: %d %q", code, stderr)
	}
	// The revoked token is set aside, so a restart stops without asking the server.
	if _, err := os.Stat(paths.CredentialsFile()); !os.IsNotExist(err) {
		t.Fatalf("credentials kept after revocation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(paths.ConfigDir, "credentials.revoked.json")); err != nil {
		t.Fatalf("revoked credentials: %v", err)
	}
	if code, _, _ := runArgs("up"); code != exitNoRestart {
		t.Fatalf("restart after revocation: %d", code)
	}
	if _, err := os.Stat(paths.LogFile()); err != nil {
		t.Fatalf("log file: %v", err)
	}
	if data, _ := os.ReadFile(paths.TmuxConfigFile()); !strings.Contains(string(data), "set -g history-limit 50000") {
		t.Fatalf("tmux config: %q", data)
	}
	// The service exits 0, so launchd's KeepAlive does not restart it either.
	writeCredentials(t, paths, srv.URL)
	code, _, stderr = runArgs("up", "--service")
	if code != 0 || !strings.Contains(stderr, "device revoked") || !strings.Contains(stderr, "the service stays stopped") {
		t.Fatalf("revoked service: %d %q", code, stderr)
	}
	if data, _ := os.ReadFile(paths.LogFile()); !strings.Contains(string(data), "up_stop_final reason=revoked") {
		t.Fatalf("log: %q", data)
	}
}

func TestUpServiceModeStopsWithoutRestartForEveryFinalReason(t *testing.T) {
	paths := isolate(t)
	previous := serviceLockWait
	serviceLockWait = 0
	t.Cleanup(func() { serviceLockWait = previous })
	expectStop := func(reason, message string) {
		t.Helper()
		code, _, stderr := runArgs("up", "--service")
		if code != 0 || !strings.Contains(stderr, message) || !strings.Contains(stderr, "run aiqsa-connect service install") {
			t.Fatalf("%s: %d %q", reason, code, stderr)
		}
		if data, _ := os.ReadFile(paths.LogFile()); !strings.Contains(string(data), "up_stop_final reason="+reason+"\n") {
			t.Fatalf("%s: log %q", reason, data)
		}
	}
	expectStop("not_logged_in", "not logged in — run aiqsa-connect login")
	writeCredentials(t, paths, "https://ai.example.com")
	os.Chmod(paths.CredentialsFile(), 0o644)
	expectStop("credentials_invalid", "chmod 600")
	os.Chmod(paths.CredentialsFile(), 0o600)
	os.WriteFile(paths.CredentialsFile(), []byte("{"), 0o600)
	expectStop("credentials_invalid", "damaged")
	writeCredentials(t, paths, "https://ai.example.com")
	release, err := daemon.AcquireLock(paths.LockFile())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	expectStop("already_running", "already running")
	for _, args := range [][]string{{"up", "--bogus"}, {"up", "--service", "--service"}, {"up", "now"}} {
		if code, _, stderr := runArgs(args...); code != 2 || !strings.Contains(stderr, "up [--service]") {
			t.Fatalf("%v: %d %q", args, code, stderr)
		}
	}
}

func TestUpServiceModeWaitsForAStoppingClient(t *testing.T) {
	paths := isolate(t)
	writeCredentials(t, paths, "https://ai.example.com")
	paths.EnsureStateDir()
	release, err := daemon.AcquireLock(paths.LockFile())
	if err != nil {
		t.Fatal(err)
	}
	previous := serviceLockWait
	serviceLockWait = 300 * time.Millisecond
	t.Cleanup(func() { serviceLockWait = previous })
	started := time.Now()
	code, _, _ := runArgs("up", "--service")
	release()
	if code != 0 || time.Since(started) < 300*time.Millisecond {
		t.Fatalf("did not wait for the lock: %d after %s", code, time.Since(started))
	}
}

func TestUpRunsHooksAndExitsZeroWhenReplaced(t *testing.T) {
	tmuxtest.New(t)
	paths, _ := config.ResolvePaths()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == protocol.DeviceEventsPath {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		hello, _ := json.Marshal(protocol.Hello{Protocol: 1, DeviceID: testDeviceID, ServerVersion: "1.0.0", MinClientVersion: "dev", Limits: protocol.DefaultHelloLimits})
		fmt.Fprintf(w, "event: hello\ndata: %s\n\nevent: replaced\ndata: {}\n\n", hello)
	}))
	defer srv.Close()
	writeCredentials(t, paths, srv.URL)
	var hooked atomic.Bool
	upHooks = append(upHooks, func(ctx context.Context, d *daemon.Daemon) error {
		hooked.Store(d != nil && ctx.Err() == nil)
		return nil
	})
	t.Cleanup(func() { upHooks = upHooks[:len(upHooks)-1] })
	code, _, stderr := runArgs("up")
	if code != 0 || !strings.Contains(stderr, "another aiqsa-connect process is connected as this device") || !hooked.Load() {
		t.Fatalf("replaced: %d %q hooked=%v", code, stderr, hooked.Load())
	}
}

func TestUpIsSingleInstance(t *testing.T) {
	paths := isolate(t)
	writeCredentials(t, paths, "https://ai.example.com")
	paths.EnsureStateDir()
	release, err := daemon.AcquireLock(paths.LockFile())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if code, _, stderr := runArgs("up"); code != exitNoRestart || !strings.Contains(stderr, "already running") {
		t.Fatalf("second up: %d %q", code, stderr)
	}
}

func TestSessionsAndAttach(t *testing.T) {
	server := tmuxtest.New(t)
	if code, stdout, _ := runArgs("sessions"); code != 0 || !strings.Contains(stdout, "No sessions.") {
		t.Fatalf("empty: %d %q", code, stdout)
	}
	dir := t.TempDir()
	id, err := server.Manager.Create(context.Background(), tmux.CreateOptions{Program: protocol.ProgramShell, Cwd: dir, Title: "Build\x1b[31m"})
	if err != nil {
		t.Fatal(err)
	}
	code, stdout, _ := runArgs("sessions")
	if code != 0 || !strings.Contains(stdout, id) || !strings.Contains(stdout, "Shell") || !strings.Contains(stdout, "Build") || strings.Contains(stdout, "\x1b") {
		t.Fatalf("list: %d %q", code, stdout)
	}
	var gotArgv []string
	realExec := execTmux
	t.Cleanup(func() { execTmux = realExec })
	execTmux = func(bin string, argv []string, env []string) error {
		gotArgv = argv
		return nil
	}
	if code, _, stderr := runArgs("attach", id); code != 0 || strings.Join(gotArgv, " ") != "tmux -u -L "+server.Socket+" attach-session -t ="+id {
		t.Fatalf("attach: %d %q %v", code, stderr, gotArgv)
	}
	if code, _, _ := runArgs("attach", "ac-missing0"); code != 1 {
		t.Fatalf("missing session: %d", code)
	}
	if code, _, _ := runArgs("attach", "not-an-id"); code != 2 {
		t.Fatalf("bad id: %d", code)
	}
}
