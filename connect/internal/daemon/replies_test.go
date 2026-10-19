package daemon

import (
	"strings"
	"testing"
)

func TestReplyFilterTellsTypingFromTerminalReplies(t *testing.T) {
	cases := []struct {
		name string
		data string
		user bool
	}{
		{"primary DA", "\x1b[?1;2c", false},
		{"secondary DA", "\x1b[>0;276;0c", false},
		{"tertiary DA", "\x1b[=0c", false},
		{"cursor position", "\x1b[24;80R", false},
		{"extended cursor position", "\x1b[?24;80R", false},
		{"private mode report", "\x1b[?2004;1$y", false},
		{"ansi mode report", "\x1b[4;2$y", false},
		{"kitty keyboard flags", "\x1b[?0u", false},
		{"XTVERSION", "\x1bP>|xterm.js(6.0.0)\x1b\\", false},
		{"DECRQSS", "\x1bP1$r0m\x1b\\", false},
		{"OSC foreground ST", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", false},
		{"OSC background BEL", "\x1b]11;rgb:0000/0000/0000\x07", false},
		{"SGR mouse press", "\x1b[<0;10;5M", false},
		{"SGR mouse release", "\x1b[<0;10;5m", false},
		{"SGR wheel", "\x1b[<64;10;5M\x1b[<65;10;5M", false},
		{"X10 mouse", "\x1b[M #!", false},
		{"focus in", "\x1b[I", false},
		{"focus out", "\x1b[O", false},
		{"tmux attach answers", "\x1b[?1;2c\x1b[>0;276;0c\x1bP>|xterm.js(6.0.0)\x1b\\\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\", false},
		{"empty", "", false},

		{"letter", "y", true},
		{"enter", "\r", true},
		{"ctrl-c", "\x03", true},
		{"utf-8 text", "привет", true},
		{"arrow", "\x1b[A", true},
		{"application arrow", "\x1bOA", true},
		{"modified arrow", "\x1b[1;5C", true},
		{"delete", "\x1b[3~", true},
		{"bracketed paste", "\x1b[200~text\x1b[201~", true},
		{"alt key", "\x1bx", true},
		{"alt-] then text", "\x1b]abc", true},
		{"alt-P then text", "\x1bPhello", true},
		{"alt-P digits then enter", "\x1bP12\r", true},
		{"esc esc", "\x1b\x1b", true},
		{"reply then typing", "\x1b[?1;2cy", true},
		{"typing then reply", "y\x1b[I", true},
		{"focus with params is not focus", "\x1b[2I", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var f replyFilter
			if got := f.userInput([]byte(tc.data)); got != tc.user {
				t.Fatalf("userInput(%q) = %v, want %v", tc.data, got, tc.user)
			}
		})
	}
}

func TestReplyFilterJoinsRepliesSplitAcrossChunks(t *testing.T) {
	reply := "\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x1b\\\x1bP>|xterm.js(6.0.0)\x1b\\\x1b[<0;10;5M\x1b[M #!"
	for cut := 1; cut < len(reply); cut++ {
		var f replyFilter
		if f.userInput([]byte(reply[:cut])) || f.userInput([]byte(reply[cut:])) {
			t.Fatalf("reply split at %d counted as typing", cut)
		}
		if len(f.tail) != 0 {
			t.Fatalf("split at %d left %q", cut, f.tail)
		}
		if !f.userInput([]byte("y")) {
			t.Fatal("typing after a reply not counted")
		}
	}
}

func TestReplyFilterUnfinishedSequences(t *testing.T) {
	var f replyFilter
	// A lone ESC may start a reply: it waits for the next chunk.
	if f.userInput([]byte("\x1b")) {
		t.Fatal("lone ESC counted")
	}
	if !f.userInput([]byte("[A")) {
		t.Fatal("arrow split after ESC not counted")
	}
	// An unfinished string that never ends is typing once it is too long.
	f = replyFilter{}
	long := "\x1b]11;" + strings.Repeat("a", maxReplyTail)
	if f.userInput([]byte(long[:10])) {
		t.Fatal("short unfinished OSC counted")
	}
	if !f.userInput([]byte(long[10:])) {
		t.Fatal("overlong unfinished OSC not counted")
	}
	if len(f.tail) != 0 {
		t.Fatal("overlong tail kept")
	}
}
