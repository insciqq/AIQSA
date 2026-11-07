package winapp

import (
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/insciqq/AIQSA/connect/internal/state"
)

func TestViewOfEveryState(t *testing.T) {
	cases := []struct {
		state      state.State
		icon       IconKind
		status     string
		connect    bool
		disconnect bool
	}{
		{state.State{Kind: state.Pairing, Origin: testOrigin, UserCode: "ABCD-EFGH"}, IconWaiting, "Waiting for approval · ABCD-EFGH", false, false},
		{state.State{Kind: state.Connecting, Origin: testOrigin}, IconWaiting, "Connecting to ai.example.com…", false, true},
		{state.State{Kind: state.Connected, Origin: "https://ai.example.com:8443"}, IconConnected, "Connected to ai.example.com:8443", false, true},
		{state.State{Kind: state.Offline, Origin: testOrigin}, IconDisconnected, "Cannot reach ai.example.com · retrying", false, true},
		{state.State{Kind: state.Disabled, Origin: testOrigin}, IconDisconnected, "AIQSA Connect is turned off on ai.example.com", false, true},
		{state.State{Kind: state.Outdated, Origin: testOrigin}, IconWaiting, "Updating AIQSA Connect…", false, true},
		{state.State{Kind: state.Revoked, Origin: testOrigin}, IconDisconnected, "Not connected", true, false},
		{state.State{Kind: state.Stopped}, IconDisconnected, "Not connected", true, false},
	}
	if len(cases) != len(state.Kinds) {
		t.Fatalf("%d cases for %d kinds", len(cases), len(state.Kinds))
	}
	for _, tc := range cases {
		view := ViewOf(tc.state, AppItems{})
		if view.Icon != tc.icon || view.Status != tc.status || view.Tooltip != "AIQSA Connect\n"+tc.status {
			t.Errorf("%s: %+v", tc.state.Kind, view)
		}
		if hasItem(view, MenuConnect) != tc.connect || hasItem(view, MenuDisconnect) != tc.disconnect {
			t.Errorf("%s: menu %+v", tc.state.Kind, view.Menu)
		}
		first, last := view.Menu[0], view.Menu[len(view.Menu)-1]
		if first.ID != MenuStatus || first.Enabled || last.ID != MenuQuit || !last.Enabled {
			t.Errorf("%s: menu %+v", tc.state.Kind, view.Menu)
		}
		open := view.Menu[2]
		if open.ID != MenuOpen || open.Label != "Open AIQSA" || open.Enabled != (tc.state.Origin != "") {
			t.Errorf("%s: open %+v", tc.state.Kind, open)
		}
	}
}

func TestTooltipFitsTheNotifyIcon(t *testing.T) {
	long := "https://" + strings.Repeat("a", 60) + "." + strings.Repeat("b", 60) + ".example"
	view := ViewOf(state.State{Kind: state.Connected, Origin: long}, AppItems{})
	if n := len(utf16.Encode([]rune(view.Tooltip))); n > MaxTooltipLength {
		t.Fatalf("tooltip %d units", n)
	}
	if got := truncateUTF16("ab😀c", 3); got != "ab" {
		t.Fatalf("split a surrogate pair: %q", got)
	}
	if got := truncateUTF16("ab😀c", 4); got != "ab😀" {
		t.Fatalf("got %q", got)
	}
}
