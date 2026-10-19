// Package monoclock stamps when a process started something, on a clock
// that every process on this computer reads alike, so that the daemon can
// order the reports of separate hook processes.
//
// On Linux the stamp is CLOCK_MONOTONIC: time since boot, never stepped
// by time synchronization (which on WSL steps the wall clock back by up
// to a second several times a minute). Elsewhere it is the wall clock:
// macOS offers no system-wide monotonic clock to Go without cgo, and its
// wall clock is slewed rather than stepped in normal operation.
package monoclock

import "time"

// Kind names the clock a stamp was read from. Stamps of different kinds
// cannot be compared.
type Kind string

const (
	// Mono is CLOCK_MONOTONIC in nanoseconds, comparable between the
	// processes of one boot of one computer.
	Mono Kind = "mono"
	// Wall is the wall clock in Unix nanoseconds.
	Wall Kind = "wall"
)

// Stamp is one reading of a clock.
type Stamp struct {
	Kind Kind
	// At is the reading in nanoseconds; positive in a valid stamp.
	At int64
}

// Valid reports whether the stamp names a known clock and a reading.
func (s Stamp) Valid() bool { return (s.Kind == Mono || s.Kind == Wall) && s.At > 0 }

// Comparable reports whether s and t are valid readings of one clock.
func (s Stamp) Comparable(t Stamp) bool { return s.Valid() && t.Valid() && s.Kind == t.Kind }

// Now reads this computer's monotonic clock where it can be read, and the
// wall clock otherwise.
func Now() Stamp {
	if at, ok := monotonic(); ok && at > 0 {
		return Stamp{Kind: Mono, At: at}
	}
	return Stamp{Kind: Wall, At: time.Now().UnixNano()}
}
