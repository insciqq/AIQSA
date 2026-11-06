package ops

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// codeOf maps a file system error to an op's reply code.
func codeOf(err error) protocol.ReasonCode {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return protocol.CodeComputerPathNotFound
	case errors.Is(err, fs.ErrPermission):
		return protocol.CodeComputerPermissionDenied
	case isNotDirError(err):
		return protocol.CodeComputerNotADirectory
	case isIsDirError(err):
		return protocol.CodeComputerIsADirectory
	}
	return protocol.CodeDeviceError
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// validDevicePath reports whether p can be sent as a result path.
func validDevicePath(p string) bool {
	return p != "" && len([]rune(p)) <= protocol.MaxCwdLength && !protocol.ControlCharacterRegexp.MatchString(p) &&
		protocol.DevicePathRegexp.MatchString(p)
}

// stat answers whether a path exists and what it is. A relative path is
// taken from the home directory.
func (e *Executor) stat(args *protocol.StatArgs) (protocol.Validator, protocol.ReasonCode) {
	target := e.resolve(e.home, args.Path)
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) || isNotDirError(err) {
		return &protocol.StatResult{Exists: false}, ""
	}
	if err != nil {
		return nil, codeOf(err)
	}
	if !validDevicePath(target) {
		return nil, protocol.CodeDeviceError
	}
	kind := protocol.StatOther
	size := int64(0)
	switch {
	case info.IsDir():
		kind = protocol.StatDir
	case info.Mode().IsRegular():
		kind, size = protocol.StatFile, info.Size()
	}
	mtime := protocol.FormatTimestamp(info.ModTime())
	return &protocol.StatResult{Exists: true, Path: &target, Kind: &kind, Size: &size, Mtime: &mtime}, ""
}

// listDirs lists one level of subdirectories, without hidden ones, sorted
// without regard to case, at most max.
func (e *Executor) listDirs(args *protocol.ListDirsArgs, max int) (protocol.Validator, protocol.ReasonCode) {
	target := e.resolve(e.home, args.Path)
	info, err := os.Stat(target)
	if err != nil {
		return nil, codeOf(err)
	}
	if !info.IsDir() {
		return nil, protocol.CodeComputerNotADirectory
	}
	if !validDevicePath(target) {
		return nil, protocol.CodeDeviceError
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, codeOf(err)
	}
	dirs := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || len([]rune(name)) > protocol.MaxDirNameLength ||
			protocol.ControlCharacterRegexp.MatchString(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			// A link to a directory counts as one.
			if info, err = os.Stat(filepath.Join(target, name)); err != nil {
				continue
			}
		}
		if !info.IsDir() || e.sys.Hidden(info) {
			continue
		}
		dirs = append(dirs, name)
	}
	slices.SortFunc(dirs, func(a, b string) int {
		if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	result := &protocol.ListDirsResult{Path: target, Dirs: dirs}
	if len(dirs) > max {
		result.Dirs, result.Truncated = dirs[:max], true
	}
	if parent, ok := parentPath(e.goos, target); ok {
		result.Parent = &parent
	}
	return result, ""
}

// recentDirs keeps the working directories of recent ops, most recent
// first, in <state>/recent-dirs.json.
type recentDirs struct {
	path string
	mu   sync.Mutex
	dirs []string
	read bool
}

type recentFile struct {
	Dirs []string `json:"dirs"`
}

func newRecentDirs(path string) *recentDirs { return &recentDirs{path: path} }

// loadLocked reads the file once; the caller holds mu.
func (r *recentDirs) loadLocked() {
	if r.read {
		return
	}
	r.read = true
	if r.path == "" {
		return
	}
	data, err := os.ReadFile(r.path)
	if err != nil {
		return
	}
	var file recentFile
	if json.Unmarshal(data, &file) == nil {
		r.dirs = file.Dirs
	}
}

// add records dir as the most recent directory; it writes the file only
// when the order changes.
func (r *recentDirs) add(goos, dir string) error {
	if !validDevicePath(dir) || !isAbsPath(goos, dir) {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	if len(r.dirs) > 0 && r.dirs[0] == dir {
		return nil
	}
	dirs := []string{dir}
	for _, existing := range r.dirs {
		if existing != dir && len(dirs) < protocol.MaxRecentDirs {
			dirs = append(dirs, existing)
		}
	}
	r.dirs = dirs
	if r.path == "" {
		return nil
	}
	data, err := json.Marshal(recentFile{Dirs: dirs})
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(r.path, data, 0o600)
}

// list returns the recorded directories that still exist, at most max.
func (r *recentDirs) list(goos string, max int) []string {
	r.mu.Lock()
	r.loadLocked()
	recorded := slices.Clone(r.dirs)
	r.mu.Unlock()
	dirs := []string{}
	for _, dir := range recorded {
		if len(dirs) >= max || slices.Contains(dirs, dir) || !validDevicePath(dir) || !isAbsPath(goos, dir) || !isDir(dir) {
			continue
		}
		dirs = append(dirs, dir)
	}
	return dirs
}
