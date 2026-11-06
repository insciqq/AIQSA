package winapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/insciqq/AIQSA/connect/internal/config"
)

// Registry locations, all under HKEY_CURRENT_USER so no administrator
// rights are needed (spec §9 step 3).
const (
	// RunKey starts the installed program at sign-in.
	RunKey = `Software\Microsoft\Windows\CurrentVersion\Run`
	// RunValue is the program's value under RunKey.
	RunValue = "AIQSA Connect"
	// UninstallKey lists the program in Windows Apps (Settings → Apps).
	UninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQSAConnect`
)

// Names on disk.
const (
	// AppName is the product name in dialogs, the tray and Windows Apps.
	AppName = "AIQSA Connect"
	// Publisher is the Publisher shown in Windows Apps.
	Publisher = "AIQSA"
	// ProgramFolderName is the program's folder under %LOCALAPPDATA%\Programs.
	ProgramFolderName = "AIQSA Connect"
	// ExeName is the installed program's file name.
	ExeName = "aiqsa-connect.exe"
	// OriginFileName holds the AIQSA origin the program was installed for,
	// in the config folder, until the computer is paired.
	OriginFileName = "origin.json"
)

// TrayArgs are the arguments of the program at sign-in: `up --tray`.
var TrayArgs = []string{"up", "--tray"}

// Layout is where the Windows client keeps its files (spec D-15).
type Layout struct {
	// ProgramDir is %LOCALAPPDATA%\Programs\AIQSA Connect.
	ProgramDir string
	// ConfigDir (%APPDATA%\AIQSA Connect) and StateDir
	// (%LOCALAPPDATA%\AIQSA Connect) are config.Paths' folders.
	ConfigDir, StateDir string
	// TempDir is the user's temporary folder, on the same volume as
	// ProgramDir; uninstall moves the running program file there.
	TempDir string
}

// Exe is the installed program.
func (l Layout) Exe() string { return filepath.Join(l.ProgramDir, ExeName) }

// OriginFile is the installed origin's file.
func (l Layout) OriginFile() string { return filepath.Join(l.ConfigDir, OriginFileName) }

// Paths are the config.Paths of this layout.
func (l Layout) Paths() config.Paths {
	return config.Paths{ConfigDir: l.ConfigDir, StateDir: l.StateDir}
}

// NewLayout places the program under localAppData\Programs beside the
// client's own config and state folders.
func NewLayout(localAppData, tempDir string, paths config.Paths) (Layout, error) {
	if !filepath.IsAbs(localAppData) || !filepath.IsAbs(tempDir) {
		return Layout{}, errors.New("cannot determine the local application data folder")
	}
	return Layout{
		ProgramDir: filepath.Join(localAppData, "Programs", ProgramFolderName),
		ConfigDir:  paths.ConfigDir,
		StateDir:   paths.StateDir,
		TempDir:    tempDir,
	}, nil
}

type originFile struct {
	Origin string `json:"origin"`
}

// SaveOrigin records the origin the program was installed for.
func (l Layout) SaveOrigin(origin string) error {
	normalized, err := config.NormalizeOrigin(origin)
	if err != nil || normalized != origin {
		return errors.New("the AIQSA address is not valid")
	}
	if err := l.Paths().EnsureConfigDir(); err != nil {
		return err
	}
	data, err := json.Marshal(originFile{Origin: origin})
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(l.OriginFile(), append(data, '\n'), 0o600)
}

// LoadOrigin reads the installed origin; empty when there is none or the
// file is damaged.
func (l Layout) LoadOrigin() string {
	data, err := os.ReadFile(l.OriginFile())
	if err != nil || len(data) > 4096 {
		return ""
	}
	var file originFile
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&file) != nil {
		return ""
	}
	if normalized, err := config.NormalizeOrigin(file.Origin); err != nil || normalized != file.Origin {
		return ""
	}
	return file.Origin
}

// Host is the origin as the user knows it: host[:port].
func Host(origin string) string {
	if u, err := url.Parse(origin); err == nil && u.Host != "" {
		return u.Host
	}
	return origin
}

// Registry is the current user's registry. Keys are paths under
// HKEY_CURRENT_USER.
type Registry interface {
	SetString(key, name, value string) error
	SetDWord(key, name string, value uint32) error
	// String reads a string value; ErrNotFound when the key or value is missing.
	String(key, name string) (string, error)
	// DeleteValue and DeleteKey succeed when there is nothing to delete.
	DeleteValue(key, name string) error
	DeleteKey(key string) error
}

// ErrNotFound is a missing registry key or value.
var ErrNotFound = errors.New("not found")

// System starts and stops the program and opens the browser.
type System interface {
	// Running reports whether a tray instance of the program runs.
	Running() bool
	// StopRunning asks the running tray instance to quit and waits for it to
	// exit, ending it when it does not; nil when none runs.
	StopRunning(ctx context.Context) error
	// Start starts exe with args, detached from this process.
	Start(exe string, args ...string) error
	// OpenURL opens an http(s) address in the default browser.
	OpenURL(url string) error
}

// Dialogs talk to the user in message boxes.
type Dialogs interface {
	// Confirm asks a question with OK and Cancel; true for OK.
	Confirm(title, text string) bool
	Inform(title, text string)
	Warn(title, text string)
}

// ownFolder reports a folder this program may remove as a whole: one named
// for the program, so an override pointing elsewhere is never emptied.
func ownFolder(dir string) bool {
	base := filepath.Base(dir)
	return filepath.IsAbs(dir) && (strings.EqualFold(base, ProgramFolderName) || strings.EqualFold(base, "aiqsa-connect"))
}

func removeOwnFolder(dir string) error {
	if !ownFolder(dir) {
		return fmt.Errorf("%s is not a folder of AIQSA Connect; it was left in place", dir)
	}
	err := os.RemoveAll(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// samePath compares Windows paths, which ignore case.
func samePath(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func quoteArg(path string) string { return `"` + path + `"` }
