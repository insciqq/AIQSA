package daemon

// A browser terminal answers on its own: tmux queries every client that
// attaches (device attributes, version, colours) and the terminal replies
// through the same input path as keystrokes, as it also reports mouse
// clicks and focus changes. Those bytes must reach tmux, but they are not
// someone typing, so they must not mark an agent session running.

const (
	esc = 0x1b
	bel = 0x07
	// maxReplyTail bounds an unfinished sequence kept for the next chunk;
	// a longer one is no reply this client knows.
	maxReplyTail = 512
)

type seqKind int

const (
	seqInput seqKind = iota
	seqReply
	seqIncomplete
)

// replyFilter tells typed input from terminal replies across the input
// chunks of one view. Only the connection's command loop uses it.
type replyFilter struct {
	// tail is an unfinished escape sequence at the end of the last chunk.
	tail []byte
}

// userInput reports whether data holds anything but terminal replies and
// reports. An escape sequence still unfinished at the end of data is kept
// for the next chunk and does not count yet: it may be the start of a reply.
func (f *replyFilter) userInput(data []byte) bool {
	buf := data
	if len(f.tail) > 0 {
		buf = append(f.tail, data...)
		f.tail = nil
	}
	user := false
	for i := 0; i < len(buf); {
		n, kind := scanSequence(buf[i:])
		switch kind {
		case seqIncomplete:
			if len(buf)-i > maxReplyTail {
				return true
			}
			f.tail = append([]byte(nil), buf[i:]...)
			return user
		case seqInput:
			user = true
		}
		i += n
	}
	return user
}

// scanSequence classifies the sequence at the start of b and returns its
// length. Bytes up to the next ESC are input; so is any escape sequence
// that is not a known reply or report.
func scanSequence(b []byte) (int, seqKind) {
	if b[0] != esc {
		n := 1
		for n < len(b) && b[n] != esc {
			n++
		}
		return n, seqInput
	}
	if len(b) < 2 {
		return 1, seqIncomplete
	}
	switch b[1] {
	case '[':
		return scanCSI(b)
	case ']':
		return scanString(b, isDigit)
	case 'P':
		return scanString(b, func(c byte) bool { return isDigit(c) || c == '>' })
	case 'O':
		// SS3: application-mode arrows and function keys.
		if len(b) < 3 {
			return len(b), seqIncomplete
		}
		return 3, seqInput
	case esc:
		return 1, seqInput
	}
	// Alt with a key.
	return 2, seqInput
}

// scanCSI classifies ESC [ <prefix?> <params> <intermediates> <final>.
func scanCSI(b []byte) (int, seqKind) {
	i := 2
	if i == len(b) {
		return len(b), seqIncomplete
	}
	// X10 mouse: ESC [ M and three raw bytes.
	if b[i] == 'M' {
		if len(b) < 6 {
			return len(b), seqIncomplete
		}
		return 6, seqReply
	}
	var prefix byte
	if b[i] >= '<' && b[i] <= '?' {
		prefix = b[i]
		i++
	}
	params := i
	for i < len(b) && b[i] >= 0x30 && b[i] <= 0x3f {
		i++
	}
	hasParams := i > params
	inter := i
	for i < len(b) && b[i] >= 0x20 && b[i] <= 0x2f {
		i++
	}
	intermediates := string(b[inter:i])
	if i == len(b) {
		return len(b), seqIncomplete
	}
	final := b[i]
	if final < 0x40 || final > 0x7e {
		// Malformed: the stray byte is scanned on its own.
		return i, seqInput
	}
	n := i + 1
	reply := false
	switch {
	case prefix == '<':
		// SGR mouse report.
		reply = intermediates == "" && (final == 'M' || final == 'm')
	case final == 'c':
		// Device attributes (primary, secondary, tertiary).
		reply = prefix == '?' || prefix == '>' || prefix == '='
	case final == 'R':
		// Cursor position report.
		reply = intermediates == "" && (prefix == 0 || prefix == '?')
	case final == 'y':
		// DECRQM mode report.
		reply = intermediates == "$"
	case final == 'u':
		// Kitty keyboard flags.
		reply = prefix == '?' && intermediates == ""
	case final == 'I', final == 'O':
		// Focus in and out.
		reply = prefix == 0 && !hasParams && intermediates == ""
	}
	if reply {
		return n, seqReply
	}
	return n, seqInput
}

// scanString classifies an OSC (ESC ]) or DCS (ESC P) reply: a first byte
// that start accepts, printable bytes, and BEL (OSC only) or ESC \ at the
// end. Anything else, such as Alt+] or Alt+P followed by typing, is input.
func scanString(b []byte, start func(byte) bool) (int, seqKind) {
	i := 2
	if i == len(b) {
		return len(b), seqIncomplete
	}
	if !start(b[i]) {
		return 2, seqInput
	}
	osc := b[1] == ']'
	if osc {
		for i < len(b) && isDigit(b[i]) {
			i++
		}
		if i == len(b) {
			return len(b), seqIncomplete
		}
		if b[i] != ';' {
			return 2, seqInput
		}
	}
	for ; i < len(b); i++ {
		switch c := b[i]; {
		case c == bel && osc:
			return i + 1, seqReply
		case c == esc:
			if i+1 == len(b) {
				return len(b), seqIncomplete
			}
			if b[i+1] == '\\' {
				return i + 2, seqReply
			}
			return 2, seqInput
		case c < 0x20 || c == 0x7f:
			return 2, seqInput
		}
	}
	return len(b), seqIncomplete
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
