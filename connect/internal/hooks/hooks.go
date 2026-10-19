// Package hooks adds and removes the client's own entries in the agents'
// user hook files: ~/.claude/settings.json (Claude Code) and
// ~/.codex/hooks.json (Codex). Both use the shape
// {"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type": "command", ...}]}]}}.
//
// An entry is the client's own when its command runs an executable named
// aiqsa-connect* with the arguments `hook claude` or `hook codex`. Nothing
// else in a file is changed: other keys, other hooks and their order stay,
// and values the client does not edit keep their exact text (the file is
// re-indented with the indentation it already uses). The hooks only report
// a status; they never print a decision, so they never change what the
// agent does.
package hooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/status"
)

// BackupSuffix names the one copy of a file taken before the client first changes it.
const BackupSuffix = ".aiqsa-connect.bak"

// maxFileBytes bounds a hook file the client reads.
const maxFileBytes = 4 << 20

// Handler fields of an entry the client installs.
type entry struct {
	event   string
	matcher string
	async   bool
	// timeout is in seconds; 0 leaves the agent's default.
	timeout int
}

// claudeEntries: every hook runs in the background except SessionEnd, which
// runs as the agent exits (an async one could be cut off) and finishes in
// milliseconds within Claude Code's default end-of-session budget.
var claudeEntries = []entry{
	{event: "UserPromptSubmit", async: true},
	{event: "PostToolUse", async: true},
	{event: "Notification", matcher: "permission_prompt|idle_prompt|agent_needs_input", async: true},
	{event: "Stop", async: true},
	{event: "SessionEnd"},
}

// codexEntries: Codex documents `async` (background, cannot block) and
// timeouts in seconds; SessionEnd always runs synchronously and allows at
// most 3 seconds.
var codexEntries = []entry{
	{event: "UserPromptSubmit", async: true, timeout: 5},
	{event: "PostToolUse", async: true, timeout: 5},
	{event: "PermissionRequest", async: true, timeout: 5},
	{event: "Stop", async: true, timeout: 5},
	{event: "SessionEnd", timeout: 3},
}

func entriesFor(agent status.Agent) []entry {
	if agent == status.AgentCodex {
		return codexEntries
	}
	return claudeEntries
}

// DefaultFile is the agent's user hook file under home.
func DefaultFile(home string, agent status.Agent) string {
	if agent == status.AgentCodex {
		return filepath.Join(home, ".codex", "hooks.json")
	}
	return filepath.Join(home, ".claude", "settings.json")
}

// Command is the hook command for agent: the shell-quoted absolute
// executable path and `hook <agent>`.
func Command(executable string, agent status.Agent) string {
	return shellQuote(executable) + " hook " + string(agent)
}

var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

func shellQuote(s string) string {
	if shellSafe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ownCommand matches a command this client installed, from any location:
// a single-quoted or plain path whose file name starts with aiqsa-connect.
var ownCommand = regexp.MustCompile(`^\s*('(?:[^']|'\\'')*'|[^\s'"]+)\s+hook\s+(claude|codex)\s*$`)

// IsOwnCommand reports whether command is one of this client's hooks.
func IsOwnCommand(command string) bool {
	m := ownCommand.FindStringSubmatch(command)
	if m == nil {
		return false
	}
	path := m[1]
	if strings.HasPrefix(path, "'") {
		path = strings.ReplaceAll(path[1:len(path)-1], `'\''`, "'")
	}
	return strings.HasPrefix(filepath.Base(path), "aiqsa-connect")
}

// ErrUnreadable explains a file the client refuses to edit.
type ErrUnreadable struct {
	Path  string
	Cause string
}

func (e *ErrUnreadable) Error() string {
	return fmt.Sprintf("%s %s; nothing was changed. Fix the file (or move it away) and run aiqsa-connect setup again", e.Path, e.Cause)
}

// Plan is the change to one hook file. Nothing is written until Apply.
type Plan struct {
	// Path is the file as named; Target is where it resolves (a symlinked
	// settings file is edited in place, the link stays).
	Path   string
	Target string
	Exists bool
	// Changed is false when the file already is as wanted.
	Changed bool
	// Delete is set when removal leaves the empty object of a file the
	// client created (no backup of an earlier version exists).
	Delete bool
	before []byte
	after  []byte
	perm   os.FileMode
}

// Backup is the path of the file's backup copy.
func (p *Plan) Backup() string { return p.Target + BackupSuffix }

// PlanInstall plans the agent's hooks in path, running executable.
func PlanInstall(path, executable string, agent status.Agent) (*Plan, error) {
	if !filepath.IsAbs(executable) {
		return nil, errors.New("the aiqsa-connect executable path is not absolute")
	}
	return plan(path, func(hooks *object) (bool, error) { return install(hooks, executable, agent) })
}

// PlanRemove plans removing every entry of this client from path.
func PlanRemove(path string) (*Plan, error) {
	return plan(path, func(hooks *object) (bool, error) {
		changed := false
		for _, event := range hooks.keys() {
			removed, err := removeOwn(hooks, event)
			if err != nil {
				return false, err
			}
			changed = changed || removed
		}
		return changed, nil
	})
}

func plan(path string, edit func(hooks *object) (bool, error)) (*Plan, error) {
	p := &Plan{Path: path, Target: path, perm: 0o600}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		p.Target = resolved
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	data, info, err := readBounded(p.Target)
	switch {
	case errors.Is(err, os.ErrNotExist):
		data = nil
	case err != nil:
		return nil, err
	default:
		if !info.Mode().IsRegular() {
			return nil, &ErrUnreadable{Path: path, Cause: "is not a regular file"}
		}
		p.Exists = true
		p.perm = info.Mode().Perm()
	}
	p.before = data
	root := &object{}
	if len(bytes.TrimSpace(data)) > 0 {
		if root, err = parseObject(data); err != nil {
			return nil, &ErrUnreadable{Path: path, Cause: "is not a valid JSON object"}
		}
	}
	var hooks *object
	value, present := root.get("hooks")
	if present {
		raw := value.(json.RawMessage)
		if !isObject(raw) {
			return nil, &ErrUnreadable{Path: path, Cause: `has a "hooks" value that is not an object`}
		}
		if hooks, err = parseObject(raw); err != nil {
			return nil, &ErrUnreadable{Path: path, Cause: `has an unreadable "hooks" value`}
		}
	} else {
		hooks = &object{}
	}
	before := len(hooks.members)
	changed, err := edit(hooks)
	if err != nil {
		if errors.Is(err, errEventNotArray) {
			return nil, &ErrUnreadable{Path: path, Cause: `has a "hooks" event that is not an array`}
		}
		return nil, err
	}
	if !changed {
		return p, nil
	}
	switch {
	case len(hooks.members) > 0:
		root.set("hooks", hooks)
	case present && before > 0:
		// Removal emptied it: the key goes with the entries.
		root.remove("hooks")
	case present:
		root.set("hooks", hooks)
	}
	var out bytes.Buffer
	if err := encode(&out, root, detectIndent(data), 0); err != nil {
		return nil, err
	}
	if !p.Exists || bytes.HasSuffix(data, []byte("\n")) {
		out.WriteByte('\n')
	}
	p.after = out.Bytes()
	p.Changed = !bytes.Equal(p.after, p.before)
	if p.Changed && p.Exists && len(root.members) == 0 {
		if _, err := os.Lstat(p.Backup()); errors.Is(err, os.ErrNotExist) {
			p.Delete = true
		}
	}
	return p, nil
}

func readBounded(path string) ([]byte, os.FileInfo, error) {
	// Opening a FIFO would wait for a writer; only regular files are read.
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return nil, info, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, info, nil
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > maxFileBytes {
		return nil, nil, &ErrUnreadable{Path: path, Cause: "is larger than 4 MiB"}
	}
	return data, info, nil
}

// Apply writes the plan: the first time the client changes an existing
// file it keeps a copy at Backup() (never overwritten later), then the file
// is replaced atomically with its previous mode.
func (p *Plan) Apply() error {
	if !p.Changed {
		return nil
	}
	if p.Delete {
		// The file holds nothing but what the client once created.
		return os.Remove(p.Target)
	}
	if p.Exists {
		if err := writeBackupOnce(p.Backup(), p.before, p.perm); err != nil {
			return fmt.Errorf("cannot back up %s: %w", p.Path, err)
		}
	} else if err := os.MkdirAll(filepath.Dir(p.Target), 0o700); err != nil {
		return err
	}
	return config.WriteFileAtomic(p.Target, p.after, p.perm)
}

func writeBackupOnce(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}
