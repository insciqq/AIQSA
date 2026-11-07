package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// logoutPaths isolates the client's folders and stores credentials for origin.
func logoutPaths(t *testing.T, origin string) config.Paths {
	t.Helper()
	t.Setenv(config.EnvConfigDir, filepath.Join(t.TempDir(), "config"))
	t.Setenv(config.EnvStateDir, filepath.Join(t.TempDir(), "state"))
	paths, err := config.ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	if origin != "" {
		if err := paths.SaveCredentials(config.Credentials{Origin: origin, DeviceID: testDeviceID, DeviceToken: testToken}); err != nil {
			t.Fatal(err)
		}
	}
	return paths
}

func TestLogoutRevokesThisDeviceAndRemovesItsCredentials(t *testing.T) {
	revokes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != api.DeviceSelfPath || r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		revokes++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	paths := logoutPaths(t, srv.URL)
	code, stdout, stderr := runArgs("logout")
	if code != 0 || stdout != "Disconnected this computer from "+srv.URL+" and removed its credentials.\n" || stderr != "" {
		t.Fatalf("logout: %d %q %q", code, stdout, stderr)
	}
	if revokes != 1 {
		t.Fatalf("revokes = %d", revokes)
	}
	if _, err := paths.LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("credentials kept: %v", err)
	}
	if strings.Contains(stdout+stderr, testToken) {
		t.Fatal("token printed")
	}
	code, stdout, _ = runArgs("logout")
	if code != 0 || stdout != "This computer is not logged in.\n" || revokes != 1 {
		t.Fatalf("second logout: %d %q", code, stdout)
	}
}

func TestLogoutRemovesCredentialsWhenAIQSACannotBeReached(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	origin := srv.URL
	srv.Close()
	paths := logoutPaths(t, origin)
	code, stdout, _ := runArgs("logout")
	if code != 0 || !strings.Contains(stdout, "Removed this computer's AIQSA credentials, but cannot reach AIQSA at "+origin) ||
		!strings.Contains(stdout, "remove it in AIQSA → AIQSA Connect") {
		t.Fatalf("logout: %d %q", code, stdout)
	}
	if _, err := paths.LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("credentials kept: %v", err)
	}
}

func TestLogoutReportsARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"code":"` + string(protocol.CodeDisabled) + `"}`))
	}))
	defer srv.Close()
	paths := logoutPaths(t, srv.URL)
	code, stdout, _ := runArgs("logout")
	if code != 0 || !strings.Contains(stdout, "AIQSA Connect is turned off on this AIQSA server") {
		t.Fatalf("logout: %d %q", code, stdout)
	}
	if _, err := paths.LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("credentials kept: %v", err)
	}
}

func TestLogoutRemovesUnreadableCredentialsWithoutCallingAIQSA(t *testing.T) {
	paths := logoutPaths(t, "")
	if err := paths.EnsureConfigDir(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.CredentialsFile(), []byte("{damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	called := false
	previous := newRevokeClient
	newRevokeClient = func(config.Credentials) interface {
		RevokeSelf(ctx context.Context) error
	} {
		called = true
		return nil
	}
	t.Cleanup(func() { newRevokeClient = previous })
	code, stdout, _ := runArgs("logout")
	if code != 0 || !strings.Contains(stdout, "unreadable AIQSA credentials") || called {
		t.Fatalf("logout: %d %q called=%v", code, stdout, called)
	}
	if _, err := os.Stat(paths.CredentialsFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credentials kept: %v", err)
	}
}
