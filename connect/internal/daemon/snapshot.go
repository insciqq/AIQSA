package daemon

import (
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// ProgramLabel is the display name of a program.
func ProgramLabel(program protocol.Program) string {
	switch program {
	case protocol.ProgramClaude:
		return "Claude Code"
	case protocol.ProgramCodex:
		return "Codex"
	}
	return "Shell"
}

// DefaultTitle is "<program> · <last directory segment>", at most 80 code points.
func DefaultTitle(program protocol.Program, cwd string) string {
	base := filepath.Base(cwd)
	if base == "." || base == "" {
		base = "/"
	}
	title := tmux.SanitizeText(ProgramLabel(program)+" · "+base, protocol.MaxTitleLength)
	if title == "" {
		return ProgramLabel(program)
	}
	return title
}

// sanitizePath strips control characters and invalid UTF-8 and truncates
// to the contract's path length; "" when the result is not absolute.
func sanitizePath(path string) string {
	path = strings.ToValidUTF8(path, "")
	var b strings.Builder
	count := 0
	for _, r := range path {
		if r < 0x20 || r >= 0x7f && r <= 0x9f {
			continue
		}
		if count == protocol.MaxCwdLength {
			break
		}
		b.WriteRune(r)
		count++
	}
	out := b.String()
	if !strings.HasPrefix(out, "/") {
		return ""
	}
	return out
}

func validTimestamp(value string) bool {
	if !protocol.TimestampRegexp.MatchString(value) {
		return false
	}
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}

// SnapshotSession turns raw tmux metadata into a contract Session. Every
// field is sanitized, so one odd session can never invalidate a batch.
func SnapshotSession(s tmux.Session, home string) protocol.Session {
	program := protocol.Program(s.Program)
	if !slices.Contains(protocol.Programs, program) {
		program = protocol.ProgramShell
	}
	cwd := ""
	for _, candidate := range []string{s.PaneCwd, s.CreationCwd, home, "/"} {
		if cwd = sanitizePath(candidate); cwd != "" {
			break
		}
	}
	title := tmux.SanitizeText(s.Title, protocol.MaxTitleLength)
	if title == "" {
		title = DefaultTitle(program, cwd)
	}
	status := protocol.SessionStatus(s.Status)
	if !slices.Contains(protocol.SessionStatuses, status) {
		status = protocol.StatusIdle
	}
	created := s.Created
	if created.IsZero() {
		created = time.Unix(0, 0)
	}
	createdAt := protocol.FormatTimestamp(created)
	statusAt := s.StatusAt
	if !validTimestamp(statusAt) {
		statusAt = createdAt
	}
	return protocol.Session{
		ID:              s.ID,
		Title:           title,
		Cwd:             cwd,
		Program:         program,
		Status:          status,
		StatusAt:        statusAt,
		CreatedAt:       createdAt,
		AttachedClients: min(max(s.Attached, 0), protocol.MaxAttachedClients),
	}
}

// SnapshotSessions sanitizes a session list, oldest first, keeping the
// newest max sessions. The result is never nil.
func SnapshotSessions(list []tmux.Session, home string, max int) []protocol.Session {
	sorted := slices.Clone(list)
	slices.SortStableFunc(sorted, func(a, b tmux.Session) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	out := make([]protocol.Session, 0, len(sorted))
	for _, s := range sorted {
		session := SnapshotSession(s, home)
		if session.Validate() != nil {
			continue
		}
		out = append(out, session)
	}
	if max >= 0 && len(out) > max {
		out = out[len(out)-max:]
	}
	return out
}

// validHome returns home when it is a valid contract path, else "/".
func validHome(home string) string {
	if home != "" && filepath.IsAbs(home) && utf8.ValidString(home) && sanitizePath(home) == home {
		return filepath.Clean(home)
	}
	return "/"
}
