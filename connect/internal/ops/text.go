package ops

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// errBinary refuses a file with NUL bytes that is not UTF-16 with a BOM.
var errBinary = errors.New("binary file")

// errUnencodable refuses an edit whose text the file's code page cannot hold.
var errUnencodable = errors.New("text not representable in the file's encoding")

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// textFile is a file's text and how it was stored, so an edit writes it
// back the same way.
type textFile struct {
	text     string
	encoding string
	bom      []byte
	// order is set for UTF-16.
	order binary.ByteOrder
	// codePage is set for a file decoded from the system's ANSI code page.
	codePage CodePage
	// raw is set for a file that is not valid UTF-8 and was not decoded from
	// a code page: text holds U+FFFD for its invalid bytes, and an edit
	// works on the bytes themselves so they stay as they were.
	raw []byte
	// ending is set for a file too large to load (scanFormat), whose text
	// is empty: the line endings of all of it.
	ending protocol.LineEnding
}

// lineEnding names the file's line endings.
func (f textFile) lineEnding() protocol.LineEnding {
	if f.ending != "" {
		return f.ending
	}
	return lineEnding(f.text)
}

// decodeText reads a text file: UTF-8 (with or without a BOM), UTF-16 LE or
// BE with a BOM, the code page cp when the bytes are not UTF-8 and cp is
// set, otherwise UTF-8 with U+FFFD. NUL bytes outside UTF-16 make it binary.
func decodeText(data []byte, cp CodePage) (textFile, error) {
	switch {
	case bytes.HasPrefix(data, bomUTF8):
		body := data[len(bomUTF8):]
		if bytes.IndexByte(body, 0) >= 0 {
			return textFile{}, errBinary
		}
		file := textFile{encoding: "utf-8-bom", bom: bomUTF8}
		if utf8.Valid(body) {
			file.text = string(body)
		} else {
			file.text, file.raw = strings.ToValidUTF8(string(body), "�"), data
		}
		return file, nil
	case bytes.HasPrefix(data, bomUTF16LE):
		return decodeUTF16(data[2:], binary.LittleEndian, "utf-16le", bomUTF16LE)
	case bytes.HasPrefix(data, bomUTF16BE):
		return decodeUTF16(data[2:], binary.BigEndian, "utf-16be", bomUTF16BE)
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return textFile{}, errBinary
	}
	if utf8.Valid(data) {
		return textFile{text: string(data), encoding: "utf-8"}, nil
	}
	if cp != nil {
		if text, ok := cp.Decode(data); ok {
			return textFile{text: text, encoding: cp.Name(), codePage: cp}, nil
		}
	}
	return textFile{text: strings.ToValidUTF8(string(data), "�"), encoding: "utf-8", raw: data}, nil
}

// chunkEnd is where a chunk of a file read in parts ends, so that no
// character is cut in two whether the file is UTF-8 or in a Windows code
// page: after its last byte below 0x40 (a line break, space, digit or
// punctuation), which is a character of its own in UTF-8 and in the
// double-byte code pages alike, whose second bytes are 0x40 or above.
// Without such a byte, only an incomplete UTF-8 sequence at its end is
// left out; a double-byte character may then be cut, which decodeChunk
// carries into the next chunk.
func chunkEnd(b []byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < 0x40 {
			return i + 1
		}
	}
	return len(trimUTF8End(b))
}

// decodeChunk checks that data, the next part of a file after the carry
// of the part before it, decodes in the code page cp. A part that is not
// the last may end inside a character: when it does not decode whole, up
// to cp.MaxCharLen()-1 bytes from its end are tried as such a character,
// and carry is what the next part goes after. Every byte is decoded in
// some part, each part starts where a character does, and so the parts
// decode exactly when the whole file does. ok is false when data does not
// decode in cp.
func decodeChunk(cp CodePage, data []byte, last bool) (carry []byte, ok bool) {
	if _, ok := cp.Decode(data); ok {
		return nil, true
	}
	if last {
		return nil, false
	}
	for cut := 1; cut < cp.MaxCharLen() && cut <= len(data); cut++ {
		if _, ok := cp.Decode(data[:len(data)-cut]); ok {
			return bytes.Clone(data[len(data)-cut:]), true
		}
	}
	return nil, false
}

func decodeUTF16(body []byte, order binary.ByteOrder, name string, bom []byte) (textFile, error) {
	if len(body)%2 != 0 {
		return textFile{}, errBinary
	}
	units := make([]uint16, len(body)/2)
	for i := range units {
		units[i] = order.Uint16(body[2*i:])
		if units[i] == 0 {
			return textFile{}, errBinary
		}
	}
	return textFile{text: string(utf16.Decode(units)), encoding: name, bom: bom, order: order}, nil
}

// encode stores text the way the file was stored.
func (f textFile) encode(text string) ([]byte, error) {
	var body []byte
	switch {
	case f.order != nil:
		units := utf16.Encode([]rune(text))
		body = make([]byte, 2*len(units))
		for i, unit := range units {
			f.order.PutUint16(body[2*i:], unit)
		}
	case f.codePage != nil:
		encoded, ok := f.codePage.Encode(text)
		if !ok {
			return nil, errUnencodable
		}
		body = encoded
	case f.raw != nil && !isASCII(text):
		// The file is not UTF-8 and no code page decodes it (a legacy encoding
		// on macOS or Linux): its encoding is unknown, so text beyond ASCII,
		// which every such encoding writes alike, is refused rather than
		// silently stored as UTF-8.
		return nil, errUnencodable
	default:
		body = []byte(text)
	}
	return append(append([]byte{}, f.bom...), body...), nil
}

// lineEnding names a text's line endings.
func lineEnding(text string) protocol.LineEnding {
	crlf := strings.Count(text, "\r\n")
	return endingOf(crlf, strings.Count(text, "\n")-crlf)
}

// endingOf names the line endings of a text with crlf "\r\n" and lf other
// "\n".
func endingOf(crlf, lf int) protocol.LineEnding {
	switch {
	case crlf == 0 && lf == 0:
		return protocol.LineEndingNone
	case crlf == 0:
		return protocol.LineEndingLF
	case lf == 0:
		return protocol.LineEndingCRLF
	}
	return protocol.LineEndingMixed
}

func toLF(text string) string   { return strings.ReplaceAll(text, "\r\n", "\n") }
func toCRLF(text string) string { return strings.ReplaceAll(toLF(text), "\n", "\r\n") }

// decodeOutput turns a command's output into valid UTF-8: as it is when it
// is UTF-8, otherwise with fallback (the console code page on Windows).
func decodeOutput(data []byte, fallback func([]byte) string) string {
	if utf8.Valid(data) {
		return string(data)
	}
	return fallback(data)
}

// truncationMarker joins the head and the tail of a cut stream.
const truncationMarker = "\n… [output truncated] …\n"

// fitStream turns a captured stream into the text a result carries: at most
// head bytes from its start and tail bytes from its end, as valid UTF-8.
// cut says the capture already dropped the middle; truncated is true when
// anything was left out.
func fitStream(head, tail []byte, cut bool, headMax, tailMax int, fallback func([]byte) string) (text string, truncated bool) {
	if !cut {
		whole := decodeOutput(append(append([]byte{}, head...), tail...), fallback)
		if len(whole) <= headMax+tailMax {
			return whole, false
		}
		return cutHeadTail(whole, whole, headMax, tailMax), true
	}
	// The cut can split a UTF-8 sequence; drop the pieces before checking.
	h, t := trimUTF8End(head), trimUTF8Start(tail)
	var headText, tailText string
	if utf8.Valid(h) && utf8.Valid(t) {
		headText, tailText = string(h), string(t)
	} else {
		headText, tailText = fallback(head), fallback(tail)
	}
	return cutHeadTail(headText, tailText, headMax, tailMax), true
}

// cutHeadTail keeps the start of headText and the end of tailText within the
// byte bounds, at rune boundaries, joined by the marker.
func cutHeadTail(headText, tailText string, headMax, tailMax int) string {
	tailMax = max(tailMax-len(truncationMarker), 0)
	return prefixBytes(headText, headMax) + truncationMarker + suffixBytes(tailText, tailMax)
}

// prefixBytes is the longest prefix of s within n bytes that ends at a rune boundary.
func prefixBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// suffixBytes is the longest suffix of s within n bytes that starts at a rune boundary.
func suffixBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	start := len(s) - n
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[start:]
}

// trimUTF8End drops an incomplete UTF-8 sequence at the end of b.
func trimUTF8End(b []byte) []byte {
	for i := 1; i <= utf8.UTFMax && i <= len(b); i++ {
		if utf8.RuneStart(b[len(b)-i]) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			return b
		}
	}
	return b
}

// trimUTF8Start drops continuation bytes at the start of b.
func trimUTF8Start(b []byte) []byte {
	for i := 0; i < utf8.UTFMax && i < len(b); i++ {
		if utf8.RuneStart(b[i]) {
			return b[i:]
		}
	}
	return b
}

// replacementFallback is the output fallback outside Windows.
func replacementFallback(data []byte) string { return strings.ToValidUTF8(string(data), "�") }

// cutLine cuts one line to max code points.
func cutLine(line string, max int) (string, bool) {
	if utf8.RuneCountInString(line) <= max {
		return line, false
	}
	count := 0
	for i := range line {
		if count == max {
			return line[:i], true
		}
		count++
	}
	return line, false
}

// isASCII reports whether text has only 7-bit characters.
func isASCII(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] >= 0x80 {
			return false
		}
	}
	return true
}
