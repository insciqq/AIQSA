// Package status turns agent hook events and terminal bells into session
// statuses. Only the event name, the notification type, the agent's own
// session (thread) id, the working directory and the first line of a
// submitted prompt are read from a hook's input; commands, messages and tool
// data are skipped unread into any value. The working directory and the
// prompt line only find the hook's session on this computer: they are
// compared in memory and never logged, stored or sent.
package status

import (
	"encoding/json"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/monoclock"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// Agent names a hook's source, as in `aiqsa-connect hook claude|codex`.
type Agent string

const (
	AgentClaude Agent = "claude"
	AgentCodex  Agent = "codex"
)

// MaxHookInputBytes bounds what a hook reads from its standard input.
const MaxHookInputBytes = 64 << 10

// BellQuietWindow is how long after a hook status a terminal bell of the
// same session is ignored: the agent's own hooks already said what happened.
const BellQuietWindow = 10 * time.Second

// Update is one status a hook or a bell reports for a session.
type Update struct {
	Status protocol.SessionStatus
	// Reason is empty when the status has none (a session that ended).
	Reason protocol.StatusReason
}

// MaxCwdBytes bounds the working directory a hook input may name.
const MaxCwdBytes = 4096

// HookInput is the part of an agent's hook input the client reads.
type HookInput struct {
	Event            string
	NotificationType string
	// Cwd is the agent session's absolute working directory, or empty. It
	// stays on this computer.
	Cwd string
	// Thread is the agent's own id of its session (session_id), or empty
	// when that is not a valid thread id.
	Thread string
	// PromptKey is the PromptKey of a submitted prompt, or empty. It stays
	// in memory on this computer.
	PromptKey string
}

// threadRegexp is what an agent's session id must look like to be sent.
var threadRegexp = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// ValidThread reports whether id can name an agent thread.
func ValidThread(id string) bool { return threadRegexp.MatchString(id) }

const (
	// minPromptKeyRunes is the shortest prompt line found anywhere on a
	// screen; a shorter one ("yes", "go on") could be on any screen, so it
	// counts only as a whole submitted-prompt line (see ScreenShows).
	minPromptKeyRunes = 8
	// maxPromptKeyRunes keeps a long line short enough to be found on the
	// screen however the agent wraps the rest.
	maxPromptKeyRunes = 60
	// promptMarker starts the line of a submitted prompt in Codex's history.
	promptMarker = "›"
)

// PromptKey is what identifies a prompt on a screen: its first non-empty
// line with whitespace collapsed, cut to its first 60 characters.
func PromptKey(prompt string) string {
	for line := range strings.Lines(prompt) {
		key := collapseSpace(line)
		if key == "" {
			continue
		}
		if utf8.RuneCountInString(key) > maxPromptKeyRunes {
			key = strings.TrimRight(string([]rune(key)[:maxPromptKeyRunes]), " ")
		}
		return key
	}
	return ""
}

// ShortPromptKey reports a key under 8 characters: ScreenShows finds it
// only as a whole prompt line, and it may still be any conversation's.
func ShortPromptKey(key string) bool {
	return key != "" && utf8.RuneCountInString(key) < minPromptKeyRunes
}

// ScreenShows reports whether a screen's text holds a prompt key. A key of
// at least 8 characters may be anywhere, with the screen's whitespace (line
// breaks included) collapsed as the key's is: an agent wraps a long prompt
// line onto several screen lines. A shorter key ("hi") counts only as a
// whole line "› hi", the way Codex shows a submitted prompt.
func ScreenShows(screen, key string) bool {
	if key == "" {
		return false
	}
	if !ShortPromptKey(key) {
		return strings.Contains(collapseSpace(screen), key)
	}
	want := promptMarker + " " + key
	for line := range strings.Lines(screen) {
		if collapseSpace(line) == want {
			return true
		}
	}
	return false
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

// ReadHookInput reads at most MaxHookInputBytes of r as one JSON object and
// returns its top-level hook_event_name, notification_type, cwd,
// session_id and the PromptKey of prompt; a cwd that is not an absolute
// path of at most MaxCwdBytes and a session_id that is not a valid thread
// id are dropped. Every other value is skipped. Input that is cut off,
// malformed or not an object yields whatever was read before the problem.
func ReadHookInput(r io.Reader) HookInput {
	in := readHookInput(r)
	if len(in.Cwd) > MaxCwdBytes || !filepath.IsAbs(in.Cwd) || strings.ContainsRune(in.Cwd, 0) {
		in.Cwd = ""
	}
	if !ValidThread(in.Thread) {
		in.Thread = ""
	}
	return in
}

func readHookInput(r io.Reader) HookInput {
	var in HookInput
	dec := json.NewDecoder(io.LimitReader(r, MaxHookInputBytes))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return in
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return in
		}
		key, _ := tok.(string)
		var target *string
		var prompt string
		switch key {
		case "session_id":
			target = &in.Thread
		case "prompt":
			target = &prompt
		case "hook_event_name":
			target = &in.Event
		case "notification_type":
			target = &in.NotificationType
		case "cwd":
			target = &in.Cwd
		}
		if target == nil {
			if err := skipValue(dec); err != nil {
				return in
			}
			continue
		}
		var value any
		if err := dec.Decode(&value); err != nil {
			return in
		}
		if s, ok := value.(string); ok {
			*target = s
		}
		if target == &prompt {
			in.PromptKey = PromptKey(prompt)
		}
	}
	return in
}

// skipValue consumes one JSON value token by token, so a large string or
// object is never held as a whole.
func skipValue(dec *json.Decoder) error {
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch tok {
		case json.Delim('{'), json.Delim('['):
			depth++
		case json.Delim('}'), json.Delim(']'):
			depth--
		}
		if depth == 0 {
			return nil
		}
	}
}

// FromHook maps an agent's hook event to a status. ok is false for events
// that say nothing about whether the agent needs its user.
func FromHook(agent Agent, in HookInput) (Update, bool) {
	switch in.Event {
	case "UserPromptSubmit", "PostToolUse":
		return Update{protocol.StatusRunning, protocol.ReasonInput}, true
	case "Stop":
		return Update{protocol.StatusWaiting, protocol.ReasonTurnEnd}, true
	case "SessionEnd":
		return Update{Status: protocol.StatusIdle}, true
	}
	switch agent {
	case AgentClaude:
		if in.Event != "Notification" {
			return Update{}, false
		}
		switch in.NotificationType {
		case "permission_prompt":
			return Update{protocol.StatusNeedsApproval, protocol.ReasonPermission}, true
		case "idle_prompt", "agent_needs_input":
			return Update{protocol.StatusWaiting, protocol.ReasonIdlePrompt}, true
		}
	case AgentCodex:
		if in.Event == "PermissionRequest" {
			return Update{protocol.StatusNeedsApproval, protocol.ReasonPermission}, true
		}
	}
	return Update{}, false
}

// Bell is the status a terminal bell reports, subject to Gate.AcceptBell;
// the daemon applies it to agent sessions only.
func Bell() Update { return Update{protocol.StatusWaiting, protocol.ReasonBell} }

// maxTrackedSessions bounds the sessions, and separately the agent threads,
// Gate orders; entries past BellQuietWindow go first.
const maxTrackedSessions = 1024

type lastHook struct {
	// mono and wall are the start stamps of the last accepted hooks of each
	// clock, zero when none; only stamps of one clock are compared.
	mono, wall int64
	// received is when the daemon accepted the last hook status, on its own
	// clock (time.Now carries a monotonic reading).
	received time.Time
}

func (h *lastHook) slot(kind monoclock.Kind) *int64 {
	if kind == monoclock.Mono {
		return &h.mono
	}
	return &h.wall
}

// Gate orders the reports of each session, and of each agent thread
// whichever session its reports go to. Agents run hooks in the background,
// so a later event's hook can reach the daemon first; a hook that started
// before the last applied one of its clock is stale. A hook without a
// stamp, or with one that cannot have come from this computer's monotonic
// clock, is applied in arrival order. A bell right after a hook status does
// not replace it.
type Gate struct {
	mu      sync.Mutex
	last    map[string]lastHook
	threads map[string]lastHook
	now     func() time.Time
	// clock is the daemon's own reading of the hooks' clock.
	clock func() monoclock.Stamp
}

// NewGate returns a gate on the given clock (time.Now when nil) for receipt
// times.
func NewGate(now func() time.Time) *Gate {
	if now == nil {
		now = time.Now
	}
	return &Gate{last: map[string]lastHook{}, threads: map[string]lastHook{}, now: now, clock: monoclock.Now}
}

// AcceptHook reports whether a hook status of the session whose hook
// started at started is not older than the last accepted one of the same
// clock, and records it when it is accepted; stamps of different clocks
// are never compared. An invalid stamp, or a monotonic one the daemon's own
// monotonic reading has not reached (another boot or clock domain), is
// never stale and orders nothing.
func (g *Gate) AcceptHook(session string, started monoclock.Stamp) bool {
	return g.AcceptThreadHook(session, "", started)
}

// AcceptThreadHook is AcceptHook for a report of an agent thread (none when
// thread is empty): it is also stale when it started before the last
// accepted report of the thread, whichever session that went to. An
// accepted report is recorded for both in one step; a stale one changes
// nothing.
func (g *Gate) AcceptThreadHook(session, thread string, started monoclock.Stamp) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	ordered := started.Valid()
	if ordered && started.Kind == monoclock.Mono {
		own := g.clock()
		ordered = own.Comparable(started) && started.At <= own.At
	}
	stale := func(entries map[string]lastHook, id string) bool {
		h, seen := entries[id]
		return seen && ordered && started.At < *h.slot(started.Kind)
	}
	if stale(g.last, session) || thread != "" && stale(g.threads, thread) {
		return false
	}
	record := func(entries map[string]lastHook, id string) {
		h, seen := entries[id]
		if !seen {
			makeRoom(entries, now)
		}
		if ordered {
			*h.slot(started.Kind) = started.At
		}
		h.received = now
		entries[id] = h
	}
	record(g.last, session)
	if thread != "" {
		record(g.threads, thread)
	}
	return true
}

// makeRoom keeps entries below maxTrackedSessions before one more is added:
// entries past BellQuietWindow go first.
func makeRoom(entries map[string]lastHook, now time.Time) {
	if len(entries) < maxTrackedSessions {
		return
	}
	for id, h := range entries {
		if now.Sub(h.received) >= BellQuietWindow {
			delete(entries, id)
		}
	}
	if len(entries) >= maxTrackedSessions {
		// Every entry is recent: a flood. Forgetting one only loosens its order.
		for id := range entries {
			delete(entries, id)
			break
		}
	}
}

// AcceptBell reports whether a bell of the session may set its status: no
// hook status arrived within BellQuietWindow.
func (g *Gate) AcceptBell(session string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	h, seen := g.last[session]
	return !seen || g.now().Sub(h.received) >= BellQuietWindow
}
