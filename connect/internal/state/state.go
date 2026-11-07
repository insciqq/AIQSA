// Package state is the connection state the client reports to whoever shows
// it: the Windows tray today, a log or nothing elsewhere. The daemon and the
// pairing flow call a Sink on every change; the Sink never blocks them and
// never sees tokens, commands, paths or file content.
package state

// Kind is what the client is doing.
type Kind string

const (
	// Pairing waits for the owner to approve the computer: UserCode and
	// VerificationURI are set.
	Pairing Kind = "pairing"
	// Connecting opens the device stream, at start or after a dropped stream.
	Connecting Kind = "connecting"
	// Connected has an open device stream and runs the agent's operations.
	Connected Kind = "connected"
	// Offline cannot reach AIQSA and keeps retrying.
	Offline Kind = "offline"
	// Revoked lost its device: removed in AIQSA, disconnected from the tray or
	// logged out. It pairs again only when the user asks.
	Revoked Kind = "revoked"
	// Disabled is refused because an administrator turned AIQSA Connect off;
	// it keeps checking.
	Disabled Kind = "disabled"
	// Outdated is refused as too old and updates itself, or needs a manual update.
	Outdated Kind = "outdated"
	// Stopped is not running the connection: quit, or not paired yet.
	Stopped Kind = "stopped"
)

// Kinds lists every Kind.
var Kinds = []Kind{Pairing, Connecting, Connected, Offline, Revoked, Disabled, Outdated, Stopped}

// Valid reports whether k is one of Kinds.
func (k Kind) Valid() bool {
	for _, known := range Kinds {
		if k == known {
			return true
		}
	}
	return false
}

// State is one report. Origin is the AIQSA origin (scheme://host[:port])
// the client belongs to; empty before it has one. UserCode and
// VerificationURI are set only while Pairing.
type State struct {
	Kind            Kind
	Origin          string
	UserCode        string
	VerificationURI string
}

// Sink receives every state change. It must return quickly and must not
// call back into the client.
type Sink func(State)

// Report calls the sink; a nil Sink discards the state.
func (s Sink) Report(state State) {
	if s != nil {
		s(state)
	}
}
