package winapp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/config"
)

const (
	testDeviceID = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11"
	testOrigin   = "https://ai.example.com"
)

var testToken = "aiqsa_connect_" + strings.Repeat("T", 43)

// journal records the outside effects of a flow in order.
type journal struct {
	mu      sync.Mutex
	entries []string
}

func (j *journal) add(format string, args ...any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.entries = append(j.entries, fmt.Sprintf(format, args...))
}

func (j *journal) list() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]string(nil), j.entries...)
}

// index is the position of the first entry starting with prefix, or -1.
func (j *journal) index(prefix string) int {
	for i, entry := range j.list() {
		if strings.HasPrefix(entry, prefix) {
			return i
		}
	}
	return -1
}

type fakeRegistry struct {
	journal *journal
	values  map[string]any
	fail    map[string]error
}

func newFakeRegistry(j *journal) *fakeRegistry {
	return &fakeRegistry{journal: j, values: map[string]any{}, fail: map[string]error{}}
}

func (r *fakeRegistry) SetString(key, name, value string) error {
	if err := r.fail["set"]; err != nil {
		return err
	}
	r.values[key+`\`+name] = value
	return nil
}

func (r *fakeRegistry) SetDWord(key, name string, value uint32) error {
	if err := r.fail["set"]; err != nil {
		return err
	}
	r.values[key+`\`+name] = value
	return nil
}

func (r *fakeRegistry) String(key, name string) (string, error) {
	value, ok := r.values[key+`\`+name].(string)
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

func (r *fakeRegistry) DeleteValue(key, name string) error {
	r.journal.add("registry delete value %s", name)
	if err := r.fail["value"]; err != nil {
		return err
	}
	delete(r.values, key+`\`+name)
	return nil
}

func (r *fakeRegistry) DeleteKey(key string) error {
	r.journal.add("registry delete key %s", key)
	if err := r.fail["key"]; err != nil {
		return err
	}
	for name := range r.values {
		if strings.HasPrefix(name, key+`\`) {
			delete(r.values, name)
		}
	}
	return nil
}

func (r *fakeRegistry) keys() []string {
	names := make([]string, 0, len(r.values))
	for name := range r.values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type fakeSystem struct {
	journal  *journal
	running  bool
	stopErr  error
	startErr error
	opened   []string
	// started are the full command lines of Start.
	started [][]string
}

func (s *fakeSystem) Running() bool { return s.running }

func (s *fakeSystem) StopRunning(context.Context) error {
	s.journal.add("stop running=%v", s.running)
	if s.stopErr != nil {
		return s.stopErr
	}
	s.running = false
	return nil
}

func (s *fakeSystem) Start(exe string, args ...string) error {
	s.journal.add("start %s %s", filepath.Base(exe), strings.Join(args, " "))
	s.started = append(s.started, append([]string{exe}, args...))
	if s.startErr != nil {
		return s.startErr
	}
	s.running = true
	return nil
}

func (s *fakeSystem) OpenURL(url string) error {
	s.journal.add("open %s", url)
	s.opened = append(s.opened, url)
	return nil
}

type fakeDialogs struct {
	journal *journal
	answers []bool
	asked   []string
	shown   []string
}

func (d *fakeDialogs) Confirm(title, text string) bool {
	d.journal.add("confirm %s", title)
	d.asked = append(d.asked, text)
	if len(d.answers) == 0 {
		return false
	}
	answer := d.answers[0]
	d.answers = d.answers[1:]
	return answer
}

func (d *fakeDialogs) Inform(title, text string) {
	d.journal.add("inform")
	d.shown = append(d.shown, text)
}

func (d *fakeDialogs) Warn(title, text string) {
	d.journal.add("warn")
	d.shown = append(d.shown, text)
}

// fakeShortcuts writes the link's arguments into the link file, as a
// stand-in for a .lnk.
type fakeShortcuts struct {
	created []string
	err     error
}

func (s *fakeShortcuts) Create(link, target, workDir, description string) error {
	s.created = append(s.created, link)
	if s.err != nil {
		return s.err
	}
	return os.WriteFile(link, []byte(strings.Join([]string{target, workDir, description}, "|")), 0o644)
}

type installFixture struct {
	installer *Installer
	journal   *journal
	registry  *fakeRegistry
	system    *fakeSystem
	dialogs   *fakeDialogs
	shortcuts *fakeShortcuts
	revoked   []config.Credentials
	revokeErr error
	home      string
}

// newInstallFixture lays out a user profile in a temporary folder:
// AppData\Local\Programs\AIQSA Connect, AppData\Roaming\AIQSA Connect,
// AppData\Local\AIQSA Connect and AppData\Local\Temp.
func newInstallFixture(t *testing.T) *installFixture {
	t.Helper()
	home := t.TempDir()
	local := filepath.Join(home, "AppData", "Local")
	temp := filepath.Join(local, "Temp")
	if err := os.MkdirAll(temp, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := NewLayout(local, temp, config.Paths{
		ConfigDir: filepath.Join(home, "AppData", "Roaming", "AIQSA Connect"),
		StateDir:  filepath.Join(local, "AIQSA Connect"),
	})
	if err != nil {
		t.Fatal(err)
	}
	layout.StartMenuDir = filepath.Join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs")
	if err := os.MkdirAll(layout.StartMenuDir, 0o700); err != nil {
		t.Fatal(err)
	}
	j := &journal{}
	f := &installFixture{journal: j, registry: newFakeRegistry(j), system: &fakeSystem{journal: j}, dialogs: &fakeDialogs{journal: j},
		shortcuts: &fakeShortcuts{}, home: home}
	f.installer = &Installer{
		Layout: layout, Registry: f.registry, System: f.system, Dialogs: f.dialogs, Shortcuts: f.shortcuts, Version: "1.2.3",
		Revoke: func(_ context.Context, creds config.Credentials) error {
			j.add("revoke %s", creds.Origin)
			f.revoked = append(f.revoked, creds)
			return f.revokeErr
		},
	}
	return f
}

// download writes a downloaded program with name and content into Downloads.
func (f *installFixture) download(t *testing.T, name, content string) string {
	t.Helper()
	dir := filepath.Join(f.home, "Downloads")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func (f *installFixture) saveCredentials(t *testing.T, origin string) {
	t.Helper()
	err := f.installer.Layout.Paths().SaveCredentials(config.Credentials{Origin: origin, DeviceID: testDeviceID, DeviceToken: testToken})
	if err != nil {
		t.Fatal(err)
	}
}

func readString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return !errors.Is(err, os.ErrNotExist)
}
