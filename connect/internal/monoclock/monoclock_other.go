//go:build !linux

package monoclock

// monotonic is unavailable here: Now falls back to the wall clock.
func monotonic() (int64, bool) { return 0, false }
