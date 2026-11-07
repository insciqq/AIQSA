//go:build windows

package ops

import "io/fs"

// canKeepSpecialBits is true: files on Windows have no setuid, setgid or
// sticky bits.
func canKeepSpecialBits(fs.FileInfo) bool { return true }

// hasFileCapabilities is false: Windows files carry no Linux capabilities.
func hasFileCapabilities(string) bool { return false }
