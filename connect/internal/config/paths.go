// Package config resolves the client's directories, validates AIQSA
// origins and stores the device credentials.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// Environment overrides, used by tests and isolated runs.
const (
	EnvConfigDir  = "AIQSA_CONNECT_CONFIG_DIR"
	EnvStateDir   = "AIQSA_CONNECT_STATE_DIR"
	EnvTmuxSocket = "AIQSA_CONNECT_TMUX_SOCKET"
)

// DefaultTmuxSocket is the tmux socket name (`tmux -L <name>`) the client owns.
const DefaultTmuxSocket = "aiqsa-connect"

const appDir = "aiqsa-connect"

var socketNameRegexp = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// Paths are the client's directories and its tmux socket name.
type Paths struct {
	// ConfigDir holds credentials.json.
	ConfigDir string
	// StateDir holds the log, the lock, the generated tmux config and recent directories.
	StateDir string
	// TmuxSocket is the tmux socket name passed with -L.
	TmuxSocket string
}

// ResolvePaths applies the overrides, then the XDG base directories, then
// ~/.config and ~/.local/state.
func ResolvePaths() (Paths, error) {
	home, homeErr := os.UserHomeDir()
	resolve := func(override, xdg, fallback string) (string, error) {
		if dir := os.Getenv(override); dir != "" {
			if !filepath.IsAbs(dir) {
				return "", fmt.Errorf("%s must be an absolute path", override)
			}
			return filepath.Clean(dir), nil
		}
		// The XDG specification ignores relative values.
		if dir := os.Getenv(xdg); dir != "" && filepath.IsAbs(dir) {
			return filepath.Join(dir, appDir), nil
		}
		if homeErr != nil || !filepath.IsAbs(home) {
			return "", errors.New("cannot determine the home directory")
		}
		return filepath.Join(home, fallback, appDir), nil
	}
	configDir, err := resolve(EnvConfigDir, "XDG_CONFIG_HOME", ".config")
	if err != nil {
		return Paths{}, err
	}
	stateDir, err := resolve(EnvStateDir, "XDG_STATE_HOME", filepath.Join(".local", "state"))
	if err != nil {
		return Paths{}, err
	}
	socket := DefaultTmuxSocket
	if name := os.Getenv(EnvTmuxSocket); name != "" {
		if !socketNameRegexp.MatchString(name) {
			return Paths{}, fmt.Errorf("%s must be 1-64 letters, digits, dots, dashes or underscores", EnvTmuxSocket)
		}
		socket = name
	}
	return Paths{ConfigDir: configDir, StateDir: stateDir, TmuxSocket: socket}, nil
}

func (p Paths) CredentialsFile() string { return filepath.Join(p.ConfigDir, "credentials.json") }
func (p Paths) LockFile() string        { return filepath.Join(p.StateDir, "up.lock") }
func (p Paths) LogFile() string         { return filepath.Join(p.StateDir, "aiqsa-connect.log") }
func (p Paths) TmuxConfigFile() string  { return filepath.Join(p.StateDir, "tmux.conf") }
func (p Paths) RecentDirsFile() string  { return filepath.Join(p.StateDir, "recent-dirs.json") }

// EnsureConfigDir creates the config directory with mode 0700.
func (p Paths) EnsureConfigDir() error { return ensurePrivateDir(p.ConfigDir) }

// EnsureStateDir creates the state directory with mode 0700.
func (p Paths) EnsureStateDir() error { return ensurePrivateDir(p.StateDir) }

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// The directory belongs to this client alone; tighten one created
	// earlier under a permissive umask.
	return os.Chmod(dir, 0o700)
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
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
	return nil
}
