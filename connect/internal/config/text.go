package config

import (
	"strings"
)

// SanitizeText removes control characters (C0, DEL, C1) and invalid UTF-8,
// trims spaces and truncates to max code points. Names the client sends
// (computer name, host name) pass through it.
func SanitizeText(value string, max int) string {
	value = strings.ToValidUTF8(value, "")
	var b strings.Builder
	count := 0
	for _, r := range value {
		if r < 0x20 || r >= 0x7f && r <= 0x9f {
			continue
		}
		if count == max {
			break
		}
		b.WriteRune(r)
		count++
	}
	return strings.TrimSpace(b.String())
}
