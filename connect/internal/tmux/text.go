package tmux

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// optionLine matches one numbered menu choice of an agent permission menu,
// with an optional selection marker: "❯ 1. Yes", "  2) No". Labels longer
// than the contract allows are truncated rather than dropped, because a
// choice that names a long path must not hide the rest of the menu.
var optionLine = regexp.MustCompile(`^\s*(?:[❯›>]\s*)?([1-9])[.)]\s+(.+)$`)

// optionScanLines is how many lines from the bottom of the screen are searched.
const optionScanLines = 30

// boxBorders are trimmed from both line ends, for menus drawn inside a box.
const boxBorders = "│┃║|"

// ParseOptions finds the last group of consecutively numbered lines (1, 2,
// 3, …) in the bottom lines of a captured screen. Indented lines that are
// not choices continue the current group, so a wrapped label does not end
// the menu. A single numbered line is not a menu.
func ParseOptions(screen string) []protocol.SessionOption {
	lines := strings.Split(strings.ReplaceAll(screen, "\r", ""), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > optionScanLines {
		lines = lines[len(lines)-optionScanLines:]
	}
	var best, current []protocol.SessionOption
	finish := func() {
		if len(current) >= 2 {
			best = current
		}
		current = nil
	}
	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t"+boxBorders)
		inner := strings.TrimLeft(line, boxBorders)
		indented := inner != "" && (inner[0] == ' ' || inner[0] == '\t')
		m := optionLine.FindStringSubmatch(inner)
		label := ""
		if m != nil {
			label = SanitizeText(m[2], protocol.MaxOptionLabelLength)
		}
		switch {
		case m != nil && label != "" && m[1] == "1":
			finish()
			current = []protocol.SessionOption{{Key: "1", Label: label}}
		case m != nil && label != "" && len(current) > 0 && int(m[1][0]-'0') == len(current)+1:
			current = append(current, protocol.SessionOption{Key: m[1], Label: label})
		case m != nil:
			finish()
		case len(current) > 0 && indented && strings.TrimSpace(inner) != "":
			// A wrapped label or a hint under the menu.
		default:
			finish()
		}
	}
	finish()
	if len(best) > protocol.MaxSessionOptions {
		best = best[:protocol.MaxSessionOptions]
	}
	return best
}

// SanitizeText removes control characters (C0, DEL, C1) and invalid UTF-8,
// trims spaces and truncates to max code points.
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

// FitHistory turns a capture into history text of at most maxBytes: valid
// UTF-8, no trailing blank lines, and when it must be cut, the oldest lines
// are dropped, starting at a line boundary when one is near.
func FitHistory(text string, maxBytes int) string {
	text = strings.ToValidUTF8(text, "�")
	lines := strings.Split(text, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	text = strings.Join(lines, "\n")
	if len(text) <= maxBytes {
		return text
	}
	cut := len(text) - maxBytes
	for cut < len(text) && !utf8.RuneStart(text[cut]) {
		cut++
	}
	if nl := strings.IndexByte(text[cut:], '\n'); nl >= 0 && nl < 4096 {
		cut += nl + 1
	}
	return text[cut:]
}
