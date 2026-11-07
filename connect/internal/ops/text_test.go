package ops

import (
	"bytes"
	"context"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestResolvePath(t *testing.T) {
	for _, tc := range []struct {
		goos, home, cwd, path, want string
	}{
		{"linux", "/home/ann", "/srv/app", "src/main.go", "/srv/app/src/main.go"},
		{"linux", "/home/ann", "/srv/app", "/etc/hosts", "/etc/hosts"},
		{"linux", "/home/ann", "/srv/app", "~/notes/../a.txt", "/home/ann/a.txt"},
		{"linux", "/home/ann", "~/proj", "x", "/home/ann/proj/x"},
		{"linux", "/home/ann", "proj", "x", "/home/ann/proj/x"},
		{"darwin", "/Users/ann", "/Users/ann/Docs", "", "/Users/ann/Docs"},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `Reports\q3.docx`, `C:\Users\ivan\Documents\Reports\q3.docx`},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `Reports/q3.docx`, `C:\Users\ivan\Documents\Reports\q3.docx`},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `D:\data\..\x.txt`, `D:\x.txt`},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `d:/data/x.txt`, `D:\data\x.txt`},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `~\Desktop`, `C:\Users\ivan\Desktop`},
		{"windows", `C:\Users\ivan`, `C:\Users\ivan\Documents`, `~/Desktop`, `C:\Users\ivan\Desktop`},
		{"windows", `C:\Users\ivan`, `D:\work`, `\temp`, `D:\temp`},
		{"windows", `C:\Users\ivan`, `C:\x`, `\\server\share\dir\f.txt`, `\\server\share\dir\f.txt`},
		{"windows", `C:\Users\ivan`, `\\server\share\dir`, `..\..\..\f.txt`, `\\server\share\f.txt`},
		{"windows", `C:\Users\ivan`, `~`, `..\..`, `C:\`},
		{"windows", `C:\Users\ivan`, `C:\x`, `E:notes.txt`, `E:\notes.txt`},
	} {
		if got := resolvePath(tc.goos, tc.home, tc.cwd, tc.path); got != tc.want {
			t.Errorf("%s: resolve(%q, %q) = %q, want %q", tc.goos, tc.cwd, tc.path, got, tc.want)
		}
	}
	for _, tc := range []struct {
		goos, path, parent string
		ok                 bool
	}{
		{"linux", "/", "", false}, {"linux", "/home", "/", true}, {"linux", "/home/ann", "/home", true},
		{"windows", `C:\`, "", false}, {"windows", `C:\Users`, `C:\`, true}, {"windows", `C:\Users\ivan`, `C:\Users`, true},
		{"windows", `\\server\share\`, "", false}, {"windows", `\\server\share\dir`, `\\server\share\`, true},
	} {
		if parent, ok := parentPath(tc.goos, tc.path); parent != tc.parent || ok != tc.ok {
			t.Errorf("%s: parent(%q) = %q %v", tc.goos, tc.path, parent, ok)
		}
	}
	for path, want := range map[string]bool{`C:\x`: true, `c:/x`: true, `\\srv\share`: true, `\\srv`: false, `C:x`: false, `x`: false, `\x`: false} {
		if isAbsPath("windows", path) != want {
			t.Errorf("isAbsPath(windows, %q) != %v", path, want)
		}
	}
}

func TestLineEndings(t *testing.T) {
	for text, want := range map[string]protocol.LineEnding{
		"": protocol.LineEndingNone, "a": protocol.LineEndingNone, "a\nb\n": protocol.LineEndingLF,
		"a\r\nb\r\n": protocol.LineEndingCRLF, "a\r\nb\n": protocol.LineEndingMixed,
	} {
		if got := lineEnding(text); got != want {
			t.Errorf("%q: %s", text, got)
		}
	}
	if toCRLF("a\nb\r\nc") != "a\r\nb\r\nc" || toLF("a\r\nb\n") != "a\nb\n" {
		t.Fatal("conversion")
	}
}

func TestDecodeTextRefusesBinaryButReadsUTF16(t *testing.T) {
	if _, err := decodeText([]byte("a\x00b"), nil); err != errBinary {
		t.Fatalf("NUL: %v", err)
	}
	if _, err := decodeText([]byte{0xFF, 0xFE, 'a'}, nil); err != errBinary {
		t.Fatalf("odd UTF-16: %v", err)
	}
	file, err := decodeText([]byte{0xFF, 0xFE, 'a', 0, '\n', 0}, nil)
	if err != nil || file.text != "a\n" {
		t.Fatalf("utf-16: %+v %v", file, err)
	}
	out, err := file.encode("b\n")
	if err != nil || !bytes.Equal(out, []byte{0xFF, 0xFE, 'b', 0, '\n', 0}) {
		t.Fatalf("encode: % x %v", out, err)
	}
	// Without a code page, bytes that are not UTF-8 read as U+FFFD.
	file, _ = decodeText([]byte("caf\xe9"), nil)
	if file.text != "caf\uFFFD" || file.encoding != "utf-8" || file.raw == nil {
		t.Fatalf("invalid: %+v", file)
	}
}

// scanFormat, which reads a file too large to load in chunks, decides as
// decodeText does from the whole file, its line endings included,
// wherever the chunks end: in UTF-8 characters, in the double-byte
// characters of a run without a byte below 0x40, between the "\r" and the
// "\n" of a line break, in UTF-16 code units, before or after the bytes
// that are not UTF-8.
func TestScanFormatDecidesAsTheWholeFileDoes(t *testing.T) {
	previous := maxTextFileBytes
	t.Cleanup(func() { maxTextFileBytes = previous })
	pieces := []string{"a", "b", "\n", "\r\n", "\r", " ", "Ш", "я", "\xc0", "\xe9", "\x98", "\xd0", "\xa8", "\x82\xa0", "\x93\xfa", "\xb1"}
	// cp932 without a byte below 0x40, so chunkEnd cuts anywhere.
	dbcsPieces := []string{"a", "\x82\xa0", "\x82\xa2", "\x93\xfa", "\x96\x7b", "\x8c\xea", "\xb1"}
	utf16Pieces := []string{"a", "\n", "\r\n", "\r", "Ш", "я", "日"}
	rng := rand.New(rand.NewPCG(3, 4))
	dir := t.TempDir()
	type decision struct {
		binary                 bool
		encoding               string
		codePage, raw, withBOM bool
		ending                 protocol.LineEnding
	}
	decide := func(file *textFile, err error) decision {
		if err != nil || file == nil {
			return decision{binary: true}
		}
		return decision{encoding: file.encoding, codePage: file.codePage != nil, raw: file.raw != nil, withBOM: file.bom != nil,
			ending: file.lineEnding()}
	}
	for i := range 3000 {
		maxTextFileBytes = int64(4 + rng.IntN(40))
		var data []byte
		switch kind := rng.IntN(6); kind {
		case 0:
			var b strings.Builder
			for b.Len() <= int(maxTextFileBytes) || rng.IntN(8) != 0 {
				b.WriteString(utf16Pieces[rng.IntN(len(utf16Pieces))])
			}
			bom := bomUTF16LE
			if rng.IntN(2) == 0 {
				bom = bomUTF16BE
			}
			data = utf16Bytes(bom, bom[0] == 0xFE, b.String())
			switch rng.IntN(20) {
			case 0:
				data = append(data, 'x')
			case 1:
				data = append(data, 0, 0, 'x', 0)
			}
		default:
			source := pieces
			if kind == 1 {
				source = dbcsPieces
			}
			var b strings.Builder
			if rng.IntN(6) == 0 {
				b.Write(bomUTF8)
			}
			// Mostly UTF-8, so the bytes that are not come late.
			utf8Only := rng.IntN(2) == 0
			for b.Len() <= int(maxTextFileBytes) || rng.IntN(8) != 0 {
				piece := source[rng.IntN(len(source))]
				if utf8Only && !utf8.ValidString(piece) && rng.IntN(20) != 0 {
					continue
				}
				b.WriteString(piece)
			}
			if rng.IntN(30) == 0 {
				b.WriteByte(0)
			}
			data = []byte(b.String())
		}
		path := filepath.Join(dir, fmt.Sprintf("f%d", i))
		writeTestFile(t, path, data)
		for _, cp := range []CodePage{nil, cp1251{}, cp932{}} {
			whole, err := decodeText(data, cp)
			want := decide(&whole, err)
			scanned, code := scanFormat(context.Background(), path, cp)
			if code != "" {
				t.Fatalf("%q: %s", data, code)
			}
			if got := decide(scanned, nil); got != want {
				t.Fatalf("% x in chunks of %d, code page %v: %+v, want %+v", data, maxTextFileBytes, cp, got, want)
			}
		}
	}
}

// A chunk that ends inside a double-byte character is carried into the
// next one, so a file in cp932 that has no byte below 0x40 decodes in it
// wherever its chunks end; a lead byte that ends the file does not.
func TestDecodeChunkCarriesACharacterCutInTwo(t *testing.T) {
	carry, ok := decodeChunk(cp932{}, []byte("\x82\xa0\x93\xfa\x82"), false)
	if !ok || !bytes.Equal(carry, []byte{0x82}) {
		t.Fatalf("cut after a lead byte: % x %v", carry, ok)
	}
	if carry, ok = decodeChunk(cp932{}, append(carry, 0xa0), true); !ok || carry != nil {
		t.Fatalf("the rest: % x %v", carry, ok)
	}
	if _, ok = decodeChunk(cp932{}, []byte("\x82\xa0\x82"), true); ok {
		t.Fatal("a lead byte that ends the file decoded")
	}
	// A byte the code page has no character for is no character cut in two.
	if _, ok = decodeChunk(cp932{}, []byte("\x82\xa0\x80\x82"), false); ok {
		t.Fatal("an invalid byte was carried past")
	}
	// A single-byte code page carries nothing.
	if _, ok = decodeChunk(cp1251{}, []byte{0xC4, 0x98}, false); ok {
		t.Fatal("cp1251 carried a byte")
	}
}

// A file read through for its encoding stops when its op ends.
func TestScanFormatStopsWithItsOp(t *testing.T) {
	previous := maxTextFileBytes
	maxTextFileBytes = 16
	t.Cleanup(func() { maxTextFileBytes = previous })
	path := filepath.Join(t.TempDir(), "large.txt")
	writeTestFile(t, path, bytes.Repeat([]byte("line\n"), 100))
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, code := textFormat(cancelled, path, nil); code != protocol.CodeComputerCancelled {
		t.Fatalf("cancelled: %q", code)
	}
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, code := textFormat(expired, path, nil); code != protocol.CodeComputerTimeout {
		t.Fatalf("deadline: %q", code)
	}
}

func TestHeadTailCaptureMatchesItsInput(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		headMax, tailMax := rng.IntN(50), rng.IntN(50)+1
		c := newHeadTail(headMax, tailMax)
		var all []byte
		for range rng.IntN(20) {
			chunk := make([]byte, rng.IntN(40))
			for i := range chunk {
				chunk[i] = byte('a' + rng.IntN(26))
			}
			c.Write(chunk)
			all = append(all, chunk...)
		}
		head, tail, cut, total := c.snapshot()
		wantHead := all[:min(headMax, len(all))]
		rest := all[len(wantHead):]
		wantTail := rest[max(len(rest)-tailMax, 0):]
		if !bytes.Equal(head, wantHead) || !bytes.Equal(tail, wantTail) || total != int64(len(all)) || cut != (len(all) > headMax+tailMax) {
			t.Fatalf("head %q/%q tail %q/%q cut %v", head, wantHead, tail, wantTail, cut)
		}
	}
}

func TestRingTakesWhatIsNewAndReportsLoss(t *testing.T) {
	r := newRing(8)
	r.write([]byte("abc"))
	if data, lost := r.take(); string(data) != "abc" || lost {
		t.Fatalf("first: %q %v", data, lost)
	}
	r.write([]byte("defgh"))
	r.write([]byte("ijklmn"))
	if data, lost := r.take(); string(data) != "ghijklmn" || !lost {
		t.Fatalf("overwritten: %q %v", data, lost)
	}
	if data, lost := r.take(); len(data) != 0 || lost || r.pending() {
		t.Fatalf("nothing new: %q %v", data, lost)
	}
	r.write([]byte(strings.Repeat("z", 20)))
	if data, lost := r.take(); string(data) != strings.Repeat("z", 8) || !lost {
		t.Fatalf("large write: %q %v", data, lost)
	}
}

func TestFitStreamCutsAtRuneBoundaries(t *testing.T) {
	text := strings.Repeat("я", 100) // 200 bytes
	c := newHeadTail(31, 61)
	c.Write([]byte(text))
	out, truncated, total := c.text(replacementFallback)
	if !truncated || total != 200 || !utf8.ValidString(out) || len(out) > 92 || !strings.Contains(out, truncationMarker) ||
		strings.ContainsRune(out, utf8.RuneError) {
		t.Fatalf("cut: %q", out)
	}
	// Output that is not UTF-8 goes to the fallback, whole.
	c = newHeadTail(2, 200)
	c.Write([]byte("\x8f\xe0" + strings.Repeat("\xa0", 300) + "\xa2\xa5\xe2"))
	out, truncated, _ = c.text(cp866Fallback)
	// The bounds count the decoded bytes: two of "Пр" fit the head.
	if !truncated || !strings.HasPrefix(out, "П\n…") || !strings.HasSuffix(out, "аавет") || len(out) > 202 {
		t.Fatalf("fallback: %q", out)
	}
	// Decoded text longer than the bounds is cut again.
	out, truncated = fitStream([]byte(strings.Repeat("\xa0", 40)), nil, false, 10, 30, cp866Fallback)
	if !truncated || len(out) > 40 || !utf8.ValidString(out) {
		t.Fatalf("grown: %q", out)
	}
}
