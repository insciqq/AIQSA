package daemon

import (
	"encoding/json"
	"os"
	"slices"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// recentDirs keeps the directories of sessions this client created, most
// recent first, in <state>/recent-dirs.json.
type recentDirs struct {
	path string
	mu   sync.Mutex
}

type recentFile struct {
	Dirs []string `json:"dirs"`
}

func (r *recentDirs) load() []string {
	data, err := os.ReadFile(r.path)
	if err != nil {
		return nil
	}
	var file recentFile
	if json.Unmarshal(data, &file) != nil {
		return nil
	}
	return file.Dirs
}

// add records dir as the most recent directory.
func (r *recentDirs) add(dir string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dirs := []string{dir}
	for _, existing := range r.load() {
		if existing != dir && len(dirs) < protocol.MaxRecentDirs {
			dirs = append(dirs, existing)
		}
	}
	data, err := json.Marshal(recentFile{Dirs: dirs})
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(r.path, data, 0o600)
}

// list returns the existing recorded directories plus home, at most max.
func (r *recentDirs) list(home string, max int) []string {
	r.mu.Lock()
	recorded := r.load()
	r.mu.Unlock()
	dirs := []string{}
	for _, dir := range append(recorded, home) {
		if len(dirs) >= max || slices.Contains(dirs, dir) || sanitizePath(dir) != dir {
			continue
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		dirs = append(dirs, dir)
	}
	return dirs
}
