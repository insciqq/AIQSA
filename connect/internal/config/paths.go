// Package config resolves the client's directories, validates AIQSA
// origins and stores the device credentials.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Environment overrides, used by tests and isolated runs.
const (
	EnvConfigDir = "AIQSA_CONNECT_CONFIG_DIR"
	EnvStateDir  = "AIQSA_CONNECT_STATE_DIR"
)

// appDir names the client's directories on macOS and Linux, windowsAppDir
// on Windows (%APPDATA%\AIQSA Connect and %LOCALAPPDATA%\AIQSA Connect).
const (
	appDir        = "aiqsa-connect"
	windowsAppDir = "AIQSA Connect"
)

// Paths are the client's directories.
type Paths struct {
	// ConfigDir holds credentials.json.
	ConfigDir string
	// StateDir holds the log, the lock and the recent working directories.
	StateDir string
}

// ResolvePaths applies the overrides, then the system's directories: on
// Windows %APPDATA% and %LOCALAPPDATA%, elsewhere the XDG base directories,
// then ~/.config and ~/.local/state.
func ResolvePaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return resolvePaths(runtime.GOOS, os.Getenv, home)
}

func resolvePaths(goos string, getenv func(string) string, home string) (Paths, error) {
	join := func(elem ...string) string {
		if goos == "windows" {
			return strings.Join(elem, `\`)
		}
		return filepath.Join(elem...)
	}
	// resolve takes the override, then base/<name> when base is absolute
	// (the XDG specification ignores relative values), then home/fallback.
	resolve := func(override, base, name, fallback string) (string, error) {
		if dir := getenv(override); dir != "" {
			if !IsAbsPath(goos, dir) {
				return "", fmt.Errorf("%s must be an absolute path", override)
			}
			if goos == "windows" {
				return dir, nil
			}
			return filepath.Clean(dir), nil
		}
		if IsAbsPath(goos, base) {
			return join(base, name), nil
		}
		if fallback == "" {
			return "", fmt.Errorf("cannot determine the %s directory", name)
		}
		if home == "" || !IsAbsPath(goos, home) {
			return "", errors.New("cannot determine the home directory")
		}
		return join(home, fallback, name), nil
	}
	var configDir, stateDir string
	var err error
	if goos == "windows" {
		if configDir, err = resolve(EnvConfigDir, getenv("APPDATA"), windowsAppDir, ""); err != nil {
			return Paths{}, err
		}
		if stateDir, err = resolve(EnvStateDir, getenv("LOCALAPPDATA"), windowsAppDir, ""); err != nil {
			return Paths{}, err
		}
		return Paths{ConfigDir: configDir, StateDir: stateDir}, nil
	}
	if configDir, err = resolve(EnvConfigDir, getenv("XDG_CONFIG_HOME"), appDir, ".config"); err != nil {
		return Paths{}, err
	}
	if stateDir, err = resolve(EnvStateDir, getenv("XDG_STATE_HOME"), appDir, filepath.Join(".local", "state")); err != nil {
		return Paths{}, err
	}
	return Paths{ConfigDir: configDir, StateDir: stateDir}, nil
}

// IsAbsPath is filepath.IsAbs of the system goos: a drive (`C:\`, `C:/`)
// or UNC (`\\server\share`) path on Windows, a path from / elsewhere.
func IsAbsPath(goos, path string) bool {
	if goos != "windows" {
		return strings.HasPrefix(path, "/")
	}
	if strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
		return len(path) > 2
	}
	return len(path) >= 3 && isDriveLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}

func isDriveLetter(c byte) bool { return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' }

func (p Paths) CredentialsFile() string { return filepath.Join(p.ConfigDir, "credentials.json") }
func (p Paths) LockFile() string        { return filepath.Join(p.StateDir, "up.lock") }
func (p Paths) LogFile() string         { return filepath.Join(p.StateDir, "aiqsa-connect.log") }
func (p Paths) RecentDirsFile() string  { return filepath.Join(p.StateDir, "recent-dirs.json") }

// EnsureConfigDir creates the config directory, private to the user.
func (p Paths) EnsureConfigDir() error { return ensurePrivateDir(p.ConfigDir) }

// EnsureStateDir creates the state directory, private to the user.
func (p Paths) EnsureStateDir() error { return ensurePrivateDir(p.StateDir) }

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return tightenDir(dir)
}

// WriteFileAtomic replaces path with data: a private temporary file in the
// same directory is written, synced and renamed over path.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		tmp.Close()
		os.Remove(tmpName)
	}
	if err := tmp.Chmod(perm); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	syncDir(dir)
	return nil
}
