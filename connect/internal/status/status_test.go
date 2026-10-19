package status

import (
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestHookEventsMapToStatuses(t *testing.T) {
	cases := []struct {
		agent        Agent
		event, notif string
		want         Update
		ok           bool
	}{
		{AgentClaude, "UserPromptSubmit", "", Update{protocol.StatusRunning, protocol.ReasonInput}, true},
		{AgentClaude, "PostToolUse", "", Update{protocol.StatusRunning, protocol.ReasonInput}, true},
		{AgentClaude, "Notification", "permission_prompt", Update{protocol.StatusNeedsApproval, protocol.ReasonPermission}, true},
		{AgentClaude, "Notification", "idle_prompt", Update{protocol.StatusWaiting, protocol.ReasonIdlePrompt}, true},
		{AgentClaude, "Notification", "agent_needs_input", Update{protocol.StatusWaiting, protocol.ReasonIdlePrompt}, true},
		{AgentClaude, "Notification", "auth_success", Update{}, false},
		{AgentClaude, "Notification", "", Update{}, false},
		{AgentClaude, "Stop", "", Update{protocol.StatusWaiting, protocol.ReasonTurnEnd}, true},
		{AgentClaude, "SessionEnd", "", Update{Status: protocol.StatusIdle}, true},
		{AgentClaude, "PermissionRequest", "", Update{}, false},
		{AgentClaude, "SessionStart", "", Update{}, false},
		{AgentCodex, "UserPromptSubmit", "", Update{protocol.StatusRunning, protocol.ReasonInput}, true},
		{AgentCodex, "PostToolUse", "", Update{protocol.StatusRunning, protocol.ReasonInput}, true},
		{AgentCodex, "PermissionRequest", "", Update{protocol.StatusNeedsApproval, protocol.ReasonPermission}, true},
		{AgentCodex, "Stop", "", Update{protocol.StatusWaiting, protocol.ReasonTurnEnd}, true},
		{AgentCodex, "SessionEnd", "", Update{Status: protocol.StatusIdle}, true},
		{AgentCodex, "Notification", "permission_prompt", Update{}, false},
		{AgentCodex, "PreToolUse", "", Update{}, false},
		{AgentCodex, "", "", Update{}, false},
	}
	for _, c := range cases {
		got, ok := FromHook(c.agent, HookInput{Event: c.event, NotificationType: c.notif})
		if ok != c.ok || got != c.want {
			t.Errorf("%s %s/%s: got %+v %v, want %+v %v", c.agent, c.event, c.notif, got, ok, c.want, c.ok)
		}
	}
	if b := Bell(); b.Status != protocol.StatusWaiting || b.Reason != protocol.ReasonBell {
		t.Errorf("bell: %+v", b)
	}
}

func TestReadHookInputReadsOnlyTheEventFields(t *testing.T) {
	in := ReadHookInput(strings.NewReader(`{"session_id":"x","prompt":"secret \"quoted\" {not json}",
		"tool_input":{"command":"rm -rf /","nested":[1,{"a":[]}]},"hook_event_name":"Notification",
		"message":"Claude needs your permission","notification_type":"permission_prompt","title":"t"}`))
	if in != (HookInput{Event: "Notification", NotificationType: "permission_prompt"}) {
		t.Fatalf("got %+v", in)
	}
	for _, input := range []string{"", "not json", "[]", `{"hook_event_name":42}`, `"Stop"`} {
		if got := ReadHookInput(strings.NewReader(input)); got != (HookInput{}) {
			t.Errorf("%q: got %+v", input, got)
		}
	}
}

func TestReadHookInputReadsTheWorkingDirectoryOfCodexPayloads(t *testing.T) {
	cases := map[string]HookInput{
		`{"session_id":"s","turn_id":"t","transcript_path":"/tmp/t.jsonl","cwd":"/home/u/project","hook_event_name":"UserPromptSubmit","model":"m","permission_mode":"default","prompt":"deploy it"}`: {Event: "UserPromptSubmit", Cwd: "/home/u/project"},
		`{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"done","cwd":"/srv/a b"}`:                                                                                        {Event: "Stop", Cwd: "/srv/a b"},
		`{"hook_event_name":"PermissionRequest","tool_name":"shell","tool_input":{"cwd":"/elsewhere","command":["ls"]},"cwd":"/work"}`:                                                                {Event: "PermissionRequest", Cwd: "/work"},
		// Only the top-level cwd counts.
		`{"hook_event_name":"PermissionRequest","tool_input":{"cwd":"/elsewhere"}}`: {Event: "PermissionRequest"},
		// Relative, empty, non-string or NUL-containing values are dropped.
		`{"hook_event_name":"Stop","cwd":"project"}`:                                   {Event: "Stop"},
		`{"hook_event_name":"Stop","cwd":""}`:                                          {Event: "Stop"},
		`{"hook_event_name":"Stop","cwd":["/a"]}`:                                      {Event: "Stop"},
		`{"hook_event_name":"Stop","cwd":"/a\u0000b"}`:                                 {Event: "Stop"},
		`{"hook_event_name":"Stop","cwd":"/` + strings.Repeat("d", MaxCwdBytes) + `"}`: {Event: "Stop"},
	}
	for input, want := range cases {
		if got := ReadHookInput(strings.NewReader(input)); got != want {
			t.Errorf("%.80q: got %+v, want %+v", input, got, want)
		}
	}
	// The longest allowed path is kept.
	long := "/" + strings.Repeat("d", MaxCwdBytes-1)
	if got := ReadHookInput(strings.NewReader(`{"cwd":"` + long + `"}`)); got.Cwd != long {
		t.Fatalf("a %d-byte cwd was dropped", len(long))
	}
	// A cwd after a huge field inside the input bound is still read.
	big := strings.Repeat("x", MaxHookInputBytes-200)
	got := ReadHookInput(strings.NewReader(`{"hook_event_name":"Stop","last_assistant_message":"` + big + `","cwd":"/work"}`))
	if got != (HookInput{Event: "Stop", Cwd: "/work"}) {
		t.Fatalf("after a large field: %+v", got)
	}
}

func TestReadHookInputIsBounded(t *testing.T) {
	big := strings.Repeat("x", 2*MaxHookInputBytes)
	// The event name comes first, as both agents send it: a huge tool
	// response after it is cut off without losing the event.
	in := ReadHookInput(strings.NewReader(`{"hook_event_name":"PostToolUse","tool_response":"` + big + `"}`))
	if in.Event != "PostToolUse" {
		t.Fatalf("got %+v", in)
	}
	// Past the bound nothing more is read.
	in = ReadHookInput(strings.NewReader(`{"tool_response":"` + big + `","hook_event_name":"Stop"}`))
	if in.Event != "" {
		t.Fatalf("read past the bound: %+v", in)
	}
}

func TestGateIgnoresBellsRightAfterAHookStatus(t *testing.T) {
	now := time.Unix(1_000, 0)
	gate := NewGate(func() time.Time { return now })
	if !gate.AcceptBell("ac-a") {
		t.Fatal("a bell without any hook status is ignored")
	}
	if !gate.AcceptHook("ac-a", time.Time{}) {
		t.Fatal("first hook refused")
	}
	now = now.Add(BellQuietWindow - time.Millisecond)
	if gate.AcceptBell("ac-a") {
		t.Fatal("a bell within the window replaces the hook status")
	}
	if !gate.AcceptBell("ac-b") {
		t.Fatal("another session's hook silences this bell")
	}
	now = now.Add(time.Millisecond)
	if !gate.AcceptBell("ac-a") {
		t.Fatal("a bell after the window is ignored")
	}
}

func TestGateDropsAHookThatStartedBeforeTheLastApplied(t *testing.T) {
	now := time.Unix(1_000, 0)
	gate := NewGate(func() time.Time { return now })
	stop, end := now.Add(-20*time.Millisecond), now.Add(-10*time.Millisecond)
	// SessionEnd's hook arrives before the earlier Stop's background hook.
	if !gate.AcceptHook("ac-a", end) || gate.AcceptHook("ac-a", stop) {
		t.Fatal("a stale hook was accepted")
	}
	if !gate.AcceptHook("ac-a", end) || !gate.AcceptHook("ac-b", stop) || !gate.AcceptHook("ac-a", now) {
		t.Fatal("an in-order hook was refused")
	}
}

func TestGateStaysBounded(t *testing.T) {
	now := time.Unix(1_000, 0)
	gate := NewGate(func() time.Time { return now })
	for i := range 3 * maxTrackedSessions {
		gate.AcceptHook("ac-"+time.Duration(i).String(), time.Time{})
		now = now.Add(time.Millisecond)
	}
	if len(gate.last) > maxTrackedSessions {
		t.Fatalf("tracked %d sessions", len(gate.last))
	}
}
