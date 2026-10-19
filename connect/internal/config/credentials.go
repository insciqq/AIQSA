package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// ErrNotLoggedIn means there is no credentials file.
var ErrNotLoggedIn = errors.New("this computer is not connected to AIQSA; run aiqsa-connect login <AIQSA address>")

// InsecureCredentialsError refuses a credentials file other users can read.
type InsecureCredentialsError struct {
	Path string
	Mode os.FileMode
}

func (e *InsecureCredentialsError) Error() string {
	return fmt.Sprintf("%s is readable by other users (mode %04o); fix it with: chmod 600 %s", e.Path, e.Mode.Perm(), e.Path)
}

// Credentials identify this computer to one AIQSA installation.
type Credentials struct {
	Origin      string `json:"origin"`
	DeviceID    string `json:"deviceId"`
	DeviceToken string `json:"deviceToken"`
}

// Validate checks the origin, device id and token formats.
func (c Credentials) Validate() error {
	origin, err := NormalizeOrigin(c.Origin)
	if err != nil {
		return err
	}
	if origin != c.Origin {
		return errors.New("origin is not normalized")
	}
	if !protocol.IDRegexp.MatchString(c.DeviceID) {
		return errors.New("deviceId is invalid")
	}
	if !protocol.DeviceTokenRegexp.MatchString(c.DeviceToken) {
		return errors.New("deviceToken is invalid")
	}
	return nil
}

const maxCredentialsBytes = 16 << 10

// LoadCredentials reads the credentials file. It refuses a file that is not
// a regular file of the current user or that group or others can access.
func (p Paths) LoadCredentials() (Credentials, error) {
	path := p.CredentialsFile()
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, ErrNotLoggedIn
	}
	if err != nil {
		return Credentials{}, fmt.Errorf("cannot open %s: %w", path, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Credentials{}, err
	}
	if !info.Mode().IsRegular() {
		return Credentials{}, fmt.Errorf("%s is not a regular file", path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return Credentials{}, fmt.Errorf("%s belongs to another user", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Credentials{}, &InsecureCredentialsError{Path: path, Mode: info.Mode()}
	}
	data, err := io.ReadAll(io.LimitReader(f, maxCredentialsBytes+1))
	if err != nil {
		return Credentials{}, err
	}
	if len(data) > maxCredentialsBytes {
		return Credentials{}, fmt.Errorf("%s is too large", path)
	}
	var creds Credentials
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&creds); err != nil {
		return Credentials{}, fmt.Errorf("%s is damaged; run aiqsa-connect login again", path)
	}
	if err := creds.Validate(); err != nil {
		return Credentials{}, fmt.Errorf("%s is damaged (%v); run aiqsa-connect login again", path, err)
	}
	return creds, nil
}

// SaveCredentials writes the credentials file atomically with mode 0600.
func (p Paths) SaveCredentials(creds Credentials) error {
	if err := creds.Validate(); err != nil {
		return err
	}
	if err := p.EnsureConfigDir(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(p.CredentialsFile(), append(data, '\n'), 0o600)
}

// RemoveCredentials deletes the credentials file; removed is false when there was none.
func (p Paths) RemoveCredentials() (removed bool, err error) {
	err = os.Remove(p.CredentialsFile())
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
