//go:build windows

package ops

import "io/fs"

// canKeepSpecialBits is true: files on Windows have no setuid, setgid or
// sticky bits.
func canKeepSpecialBits(fs.FileInfo) bool { return true }
