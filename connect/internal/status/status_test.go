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
