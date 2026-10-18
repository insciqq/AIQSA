package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeOrigin(t *testing.T) {
	accepted := map[string]string{
		"https://ai.example.com":       "https://ai.example.com",
		"https://AI.Example.com/":      "https://ai.example.com",
		" https://ai.example.com:8443": "https://ai.example.com:8443",
		"HTTPS://ai.example.com":       "https://ai.example.com",
		"http://localhost:3000":        "http://localhost:3000",
		"http://127.0.0.1:3000/":       "http://127.0.0.1:3000",
		"http://127.10.0.1":            "http://127.10.0.1",
		"http://[::1]:3000":            "http://[::1]:3000",
	}
	for raw, want := range accepted {
		got, err := NormalizeOrigin(raw)
		if err != nil || got != want {
			t.Errorf("NormalizeOrigin(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	refused := []string{
		"", "ai.example.com", "ftp://ai.example.com", "http://ai.example.com",
		"http://10.0.0.1", "http://localhost.example.com", "https://ai.example.com/app",
		"https://ai.example.com/?x=1", "https://ai.example.com/#top", "https://user:pw@ai.example.com",
		"https://ai.example.com:0", "https://ai.example.com:99999", "https://", "https://ai.example.com:",
		"https://ai.example.com?", "javascript:alert(1)",
	}
	for _, raw := range refused {
		if got, err := NormalizeOrigin(raw); err == nil {
			t.Errorf("NormalizeOrigin(%q) accepted as %q", raw, got)
		}
	}
}

func TestResolvePaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(EnvConfigDir, "")
	t.Setenv(EnvStateDir, "")
	t.Setenv(EnvTmuxSocket, "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_STATE_HOME", "relative/ignored")
	paths, err := ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	if paths.ConfigDir != filepath.Join(home, ".config", "aiqsa-connect") ||
		paths.StateDir != filepath.Join(home, ".local", "state", "aiqsa-connect") ||
		paths.TmuxSocket != DefaultTmuxSocket {
		t.Fatalf("defaults: %+v", paths)
	}
	t.Setenv("XDG_CONFIG_HOME", "/xdg/config")
	t.Setenv("XDG_STATE_HOME", "/xdg/state")
	paths, _ = ResolvePaths()
	if paths.ConfigDir != "/xdg/config/aiqsa-connect" || paths.StateDir != "/xdg/state/aiqsa-connect" {
		t.Fatalf("xdg: %+v", paths)
	}
	t.Setenv(EnvConfigDir, "/override/config")
	t.Setenv(EnvStateDir, "/override/state")
	t.Setenv(EnvTmuxSocket, "aiqsa-connect-test-1")
	paths, _ = ResolvePaths()
	if paths.ConfigDir != "/override/config" || paths.StateDir != "/override/state" || paths.TmuxSocket != "aiqsa-connect-test-1" {
		t.Fatalf("overrides: %+v", paths)
	}
	t.Setenv(EnvTmuxSocket, "bad/name")
	if _, err := ResolvePaths(); err == nil {
		t.Fatal("bad socket name accepted")
	}
	t.Setenv(EnvTmuxSocket, "")
	t.Setenv(EnvStateDir, "relative")
	if _, err := ResolvePaths(); err == nil {
		t.Fatal("relative override accepted")
	}
}

func testCredentials() Credentials {
	return Credentials{
		Origin:      "https://ai.example.com",
		DeviceID:    "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11",
		DeviceToken: "aiqsa_connect_" + strings.Repeat("A", 43),
	}
}

func TestCredentialsRoundTripIsPrivate(t *testing.T) {
	paths := Paths{ConfigDir: filepath.Join(t.TempDir(), "config")}
	if _, err := paths.LoadCredentials(); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("missing file: %v", err)
	}
	creds := testCredentials()
	if err := paths.SaveCredentials(creds); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(paths.CredentialsFile())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode: %v %v", info.Mode(), err)
	}
	dirInfo, err := os.Stat(paths.ConfigDir)
	if err != nil || dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("config dir mode: %v %v", dirInfo.Mode(), err)
	}
	got, err := paths.LoadCredentials()
	if err != nil || got != creds {
		t.Fatalf("load: %+v %v", got, err)
	}
	removed, err := paths.RemoveCredentials()
	if !removed || err != nil {
		t.Fatalf("remove: %v %v", removed, err)
	}
	if removed, err := paths.RemoveCredentials(); removed || err != nil {
		t.Fatalf("second remove: %v %v", removed, err)
	}
}

func TestCredentialsReadableByOthersAreRefused(t *testing.T) {
	paths := Paths{ConfigDir: t.TempDir()}
	if err := paths.SaveCredentials(testCredentials()); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(paths.CredentialsFile(), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := paths.LoadCredentials()
	var insecure *InsecureCredentialsError
	if !errors.As(err, &insecure) || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("0644 file: %v", err)
	}
	if err := os.Chmod(paths.CredentialsFile(), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := paths.LoadCredentials(); !errors.As(err, &insecure) {
		t.Fatalf("0640 file: %v", err)
	}
}

func TestCredentialsRejectDamagedFiles(t *testing.T) {
	paths := Paths{ConfigDir: t.TempDir()}
	for _, body := range []string{
		`not json`,
		`{"origin":"https://ai.example.com","deviceId":"x","deviceToken":"y"}`,
		`{"origin":"http://ai.example.com","deviceId":"0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11","deviceToken":"aiqsa_connect_` + strings.Repeat("A", 43) + `"}`,
		`{"origin":"https://ai.example.com","deviceId":"0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11","deviceToken":"aiqsa_connect_` + strings.Repeat("A", 43) + `","extra":1}`,
	} {
		if err := os.WriteFile(paths.CredentialsFile(), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := paths.LoadCredentials(); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
	link := filepath.Join(t.TempDir(), "target.json")
	if err := os.WriteFile(link, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Remove(paths.CredentialsFile())
	if err := os.Symlink(link, paths.CredentialsFile()); err != nil {
		t.Fatal(err)
	}
	if _, err := paths.LoadCredentials(); err == nil {
		t.Error("followed a symlink")
	}
}
