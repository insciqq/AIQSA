package ops

import (
	"bytes"
	"math/rand/v2"
	"strings"
	"testing"
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
