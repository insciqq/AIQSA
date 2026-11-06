package winapp

import (
	"unicode/utf16"

	"github.com/insciqq/AIQSA/connect/internal/state"
)

// IconKind is the tray icon: the AIQSA icon with a status dot.
type IconKind int

const (
	// IconDisconnected has a grey dot: not connected, offline, turned off.
	IconDisconnected IconKind = iota
	// IconWaiting has an amber dot: pairing, connecting, updating.
	IconWaiting
	// IconConnected has a green dot.
	IconConnected
)

// MenuID names a tray menu command.
type MenuID int

const (
	// MenuStatus is the inactive status line.
	MenuStatus MenuID = iota + 1
	MenuOpen
	MenuConnect
	MenuDisconnect
	MenuQuit
	// MenuSeparator is a line between groups.
	MenuSeparator
)

// MenuItem is one line of the tray menu.
type MenuItem struct {
	ID      MenuID
	Label   string
	Enabled bool
}

// View is what the tray shows for a state.
type View struct {
	Icon IconKind
	// Status is the first, inactive menu line.
	Status string
	// Tooltip shows on hover; at most MaxTooltipLength UTF-16 units.
	Tooltip string
	Menu    []MenuItem
}

// MaxTooltipLength is the tooltip's limit: NOTIFYICONDATAW.szTip holds 128
// UTF-16 units with the terminating zero.
const MaxTooltipLength = 127

// ViewOf is the tray for s (spec O-06, §9 step 6).
func ViewOf(s state.State) View {
	host := "AIQSA"
	if s.Origin != "" {
		host = Host(s.Origin)
	}
	view := View{Icon: IconDisconnected}
	canDisconnect, canConnect := false, false
	switch s.Kind {
	case state.Pairing:
		view.Icon, view.Status = IconWaiting, "Waiting for approval · "+s.UserCode
	case state.Connecting:
		view.Icon, view.Status, canDisconnect = IconWaiting, "Connecting to "+host+"…", true
	case state.Connected:
		view.Icon, view.Status, canDisconnect = IconConnected, "Connected to "+host, true
	case state.Offline:
		view.Status, canDisconnect = "Cannot reach "+host+" · retrying", true
	case state.Disabled:
		view.Status, canDisconnect = "AIQSA Connect is turned off on "+host, true
	case state.Outdated:
		view.Icon, view.Status, canDisconnect = IconWaiting, "Updating AIQSA Connect…", true
	default: // Revoked, Stopped
		view.Status, canConnect = "Not connected", true
	}
	view.Tooltip = truncateUTF16(AppName+"\n"+view.Status, MaxTooltipLength)
	view.Menu = []MenuItem{
		{ID: MenuStatus, Label: view.Status},
		{ID: MenuSeparator},
		{ID: MenuOpen, Label: "Open AIQSA", Enabled: s.Origin != ""},
	}
	if canConnect {
		view.Menu = append(view.Menu, MenuItem{ID: MenuConnect, Label: "Connect…", Enabled: true})
	}
	if canDisconnect {
		view.Menu = append(view.Menu, MenuItem{ID: MenuDisconnect, Label: "Disconnect this computer", Enabled: true})
	}
	view.Menu = append(view.Menu, MenuItem{ID: MenuSeparator}, MenuItem{ID: MenuQuit, Label: "Quit", Enabled: true})
	return view
}

func utf16Units(s string) []uint16 { return utf16.Encode([]rune(s)) }

// truncateUTF16 cuts s to at most limit UTF-16 units without splitting a
// surrogate pair.
func truncateUTF16(s string, limit int) string {
	units := 0
	for i, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > limit {
			return s[:i]
		}
		units += n
	}
	return s
}
